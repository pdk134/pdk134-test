"""合并 LoRA adapter 到基座，产出可直接被 vLLM / Transformers 加载的完整模型。

用法： python train/merge.py --adapter outputs/lora-v1 --out outputs/lora-v1-merged
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--adapter', required=True)
    ap.add_argument('--base-model', default=None,
                    help='默认读 outputs/<name>/experiment.json 里的 model_name_or_path')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    import json
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    adapter = Path(args.adapter)
    exp = adapter / 'experiment.json'
    base = args.base_model
    if not base and exp.exists():
        base = json.loads(exp.read_text(encoding='utf-8'))['config']['model_name_or_path']
    if not base:
        raise SystemExit('请指定 --base-model，或提供 experiment.json')

    out = Path(args.out or str(adapter) + '-merged')
    out.mkdir(parents=True, exist_ok=True)

    print('加载基座:', base)
    model = AutoModelForCausalLM.from_pretrained(
        base, torch_dtype=torch.bfloat16, device_map='cpu', trust_remote_code=True)
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    print('挂载 adapter:', adapter)
    model = PeftModel.from_pretrained(model, str(adapter))
    model = model.merge_and_unload()
    model.save_pretrained(str(out), safe_serialization=True)
    tok.save_pretrained(str(out))
    print('已保存合并模型:', out)


if __name__ == '__main__':
    main()
