"""训练入口：LLaMA-Factory（默认）或 Unsloth，并记录实验快照。

用法：
  python train/train.py --backend llamafactory --name v1
  python train/train.py --backend llamafactory --name v3 --set lora_rank=8
  python train/train.py --backend unsloth --name v1
  python train/train.py --dry-run              # 只检查环境/配置，不真正训练

每组实验都会在 outputs/<name>/ 下留一份 experiment.json，
供 eval/run_eval.py 汇总对比表时读取超参，避免结果和参数对不上。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

CONFIG = Path(__file__).with_name('lora_config.yaml')
OUTPUTS = ROOT / 'outputs'


def parse_overrides(items):
    out = {}
    for it in items or []:
        if '=' not in it:
            raise SystemExit(f'--set 格式应为 key=value，收到: {it}')
        k, v = it.split('=', 1)
        out[k.strip()] = v.strip()
    return out


def load_yaml():
    import yaml
    return yaml.safe_load(CONFIG.read_text(encoding='utf-8'))


def dump_yaml(cfg, path):
    import yaml
    path.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding='utf-8')


def prepare(name, overrides, base_model=None, epochs=None, lr=None, rank=None):
    cfg = load_yaml()
    if base_model:
        cfg['model_name_or_path'] = base_model
    if epochs:
        cfg['num_train_epochs'] = float(epochs)
    if lr:
        cfg['learning_rate'] = float(lr)
    if rank:
        cfg['lora_rank'] = int(rank)
        cfg['lora_alpha'] = int(rank) * 2
    for k, v in overrides.items():
        cfg[k] = yaml_scalar(v)
    cfg['output_dir'] = str(OUTPUTS / ('lora-' + name))
    return cfg


def yaml_scalar(v):
    if v.lower() in ('true', 'false'):
        return v.lower() == 'true'
    if v.lower() in ('null', 'none'):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        return v


def check(cmd, hint):
    if shutil.which(cmd) is None:
        raise SystemExit(f'未找到 {cmd}。{hint}')


def run_llamafactory(cfg, name, dry_run):
    if dry_run:
        return
    check('llamafactory-cli',
          '请先 pip install -e ".[torch,metrics]" 安装 LLaMA-Factory')
    tmp = ROOT / 'train' / ('_' + name + '.yaml')
    dump_yaml(cfg, tmp)
    try:
        env = dict(os.environ)
        env['PYTHONPATH'] = str(ROOT) + os.pathsep + env.get('PYTHONPATH', '')
        subprocess.run(['llamafactory-cli', 'train', str(tmp)], cwd=str(ROOT),
                       env=env, check=True)
    finally:
        tmp.unlink(missing_ok=True)


def run_unsloth(cfg, name, dry_run):
    """Unsloth 分支：显存更省，适合单卡 24G 跑 7B。"""
    if dry_run:
        return
    from unsloth import FastLanguageModel
    from trl import SFTTrainer
    from transformers import TrainingArguments
    from datasets import load_dataset
    import torch

    base = cfg['model_name_or_path']
    model, tok = FastLanguageModel.from_pretrained(
        model_name=base, max_seq_length=cfg['cutoff_len'],
        dtype=torch.bfloat16, load_in_4bit=True
    )
    model = FastLanguageModel.get_peft_model(
        model, r=cfg['lora_rank'], lora_alpha=cfg['lora_alpha'],
        lora_dropout=cfg['lora_dropout'],
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj',
                        'gate_proj', 'up_proj', 'down_proj'],
        bias='none', use_gradient_checkpointing='unsloth'
    )
    ds = load_dataset('json', data_files=str(ROOT / 'data' / 'train.jsonl'), split='train')

    # input 字段已包含「表结构 + 问题」，由 common/schema.py 统一构造，
    # 不能拿 instruction（系统指令）当问题，否则训练/评测 Prompt 不一致。
    def fmt(ex):
        return {'text': ex['instruction'] + '\n\n' + ex['input']
                + '\n' + ex['output'] + tok.eos_token}

    ds = ds.map(fmt)
    trainer = SFTTrainer(
        model=model, tokenizer=tok, train_dataset=ds,
        dataset_text_field='text', max_seq_length=cfg['cutoff_len'],
        args=TrainingArguments(
            per_device_train_batch_size=cfg['per_device_train_batch_size'],
            gradient_accumulation_steps=cfg['gradient_accumulation_steps'],
            num_train_epochs=cfg['num_train_epochs'],
            learning_rate=cfg['learning_rate'],
            lr_scheduler_type=cfg['lr_scheduler_type'],
            warmup_ratio=cfg['warmup_ratio'],
            bf16=True, logging_steps=10,
            output_dir=cfg['output_dir'], report_to='none'
        )
    )
    trainer.train()
    model.save_pretrained(cfg['output_dir'])
    tok.save_pretrained(cfg['output_dir'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', choices=['llamafactory', 'unsloth'], default='llamafactory')
    ap.add_argument('--name', default='v1', help='实验名，如 base / v1 / v2 / v3')
    ap.add_argument('--base-model', default=None)
    ap.add_argument('--epochs', type=float, default=None)
    ap.add_argument('--lr', type=float, default=None)
    ap.add_argument('--rank', type=int, default=None)
    ap.add_argument('--set', dest='overrides', action='append', default=[])
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    cfg = prepare(args.name, parse_overrides(args.overrides),
                  args.base_model, args.epochs, args.lr, args.rank)
    out = Path(cfg['output_dir'])
    out.mkdir(parents=True, exist_ok=True)

    snapshot = {
        'name': args.name, 'backend': args.backend,
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'train_data': 'data/train.jsonl',
        'eval_data': 'data/eval.jsonl (frozen)',
        'config': cfg
    }
    (out / 'experiment.json').write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2), encoding='utf-8')

    print('实验:', args.name, '| backend:', args.backend)
    print('  base_model :', cfg['model_name_or_path'])
    print('  rank/alpha :', cfg['lora_rank'], '/', cfg['lora_alpha'])
    print('  epochs/lr  :', cfg['num_train_epochs'], '/', cfg['learning_rate'])
    print('  output_dir :', cfg['output_dir'])
    if args.dry_run:
        print('[dry-run] 配置检查通过，未启动训练。')
        return
    if args.backend == 'llamafactory':
        run_llamafactory(cfg, args.name, args.dry_run)
    else:
        run_unsloth(cfg, args.name, args.dry_run)
    print('训练完成，adapter:', cfg['output_dir'])


if __name__ == '__main__':
    main()
