"""
训练脚本：从零训练上面手写的 GPT。

既可以直接命令行运行（见下方用法），也暴露 run_training() 供 GUI 客户端调用。

用法：
  python train.py                      # 用默认示例语料训练
  python train.py --data your.txt     # 用你自己的文本（UTF-8）训练
  python train.py --max_iters 3000    # 训练更多步

产出（默认目录 checkpoints/）：
  tokenizer.json   分词器（merges + vocab）
  model.pt         模型权重 + 配置
"""
import argparse
import math
import os
import sys
import time

import torch

# 显式限制 torch 线程数：小模型(6M)在 CPU 上若放任默认线程(可能数十个)
# 会因线程过度订阅导致有效算力被调度开销吃掉、训练极慢。4 线程对 6M 模型足够。
import os as _os

_tn = int(_os.environ.get("LLM_THREADS", "4"))
try:
    torch.set_num_threads(_tn)
except Exception:
    pass

# 强制 stdout 使用 UTF-8，避免 Windows(GBK) 控制台或重定向日志里中文变乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from torch.nn.utils import clip_grad_norm_

from config import GPTConfig
from model import GPT
from tokenizer import BPETokenizer

# 找不到数据文件时，自动生成一份示例语料（重复一段英文散文）
_SAMPLE_BASE = (
    "The old library stood at the end of the quiet street. "
    "Every morning the keeper opened its heavy wooden doors and "
    "let the sunlight fall upon the dusty shelves. Children came to "
    "read tales of distant lands, while the wind moved softly through "
    "the trees outside. Knowledge, he believed, was a gentle light that "
    "could guide anyone who was willing to listen. So he smiled, and the "
    "pages turned, and another small story found its reader. "
)


def make_sample_data(path, n_repeat=80):
    text = (_SAMPLE_BASE + "\n") * n_repeat
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def load_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def get_batch(tokens, cfg, device):
    ix = torch.randint(0, len(tokens) - cfg.max_seq, (cfg.batch_size,))
    x = torch.stack(
        [torch.tensor(tokens[i : i + cfg.max_seq], dtype=torch.long) for i in ix]
    )
    y = torch.stack(
        [torch.tensor(tokens[i + 1 : i + 1 + cfg.max_seq], dtype=torch.long) for i in ix]
    )
    return x.to(device), y.to(device)


@torch.no_grad()
def estimate_loss(model, tokens, cfg, device):
    model.eval()
    losses = torch.zeros(cfg.eval_iters)
    for k in range(cfg.eval_iters):
        x, y = get_batch(tokens, cfg, device)
        _, loss = model(x, y)
        losses[k] = loss.item()
    model.train()
    return losses.mean().item()


def get_lr(it, cfg):
    if it < cfg.warmup_iters:
        return cfg.learning_rate * it / max(1, cfg.warmup_iters)
    progress = (it - cfg.warmup_iters) / max(1, cfg.max_iters - cfg.warmup_iters)
    return 0.5 * cfg.learning_rate * (1.0 + math.cos(math.pi * min(1.0, progress)))


def run_training(cfg, data_path, out_dir, progress_cb=None, stop_event=None,
                 val_frac=0.05):
    """执行完整训练流程，可被 CLI 或 GUI 调用。

    progress_cb 会被以关键字形式调用，例如：
        progress_cb(stage='init', msg='device: cpu')
        progress_cb(stage='train', iter=10, total=1000, loss=5.1, val=5.0, lr=1e-3, msg='...')
        progress_cb(stage='done', msg='训练完成 ...')
    stop_event 为 threading.Event，若被置位则提前停止训练。
    返回 (tokenizer, model, cfg)。

    val_frac: 验证集占比（从语料尾部切分，训练时不参与）。
        val loss 与 train loss 分别计算，才是真实泛化指标；
        早期版本二者共用同一批 token，val 形同自测。
    """
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs("data", exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if progress_cb:
        progress_cb(stage="init", msg=f"device: {device}")

    # ---------- 数据 ----------
    if not os.path.exists(data_path):
        if progress_cb:
            progress_cb(msg=f"未找到 {data_path}，自动生成示例语料...")
        text = make_sample_data(data_path)
    else:
        text = load_text(data_path)
    if progress_cb:
        progress_cb(msg=f"语料字符数: {len(text)}")

    # ---------- 分词器 ----------
    tok_path = os.path.join(out_dir, "tokenizer.json")
    t0 = time.time()
    if os.path.exists(tok_path):
        # 断点续训：直接复用已有分词器，避免词表变化导致模型权重对不上
        tok = BPETokenizer.load(tok_path)
        if progress_cb:
            progress_cb(msg=f"复用已有分词器: 词表 {len(tok.vocab)}")
    else:
        tok = BPETokenizer()
        if progress_cb:
            progress_cb(msg="训练分词器...")
        # 分词器只需采样部分语料即可学出子词；用子样本大幅加速（中文唯一词极多，全量很慢）
        tok_text = text[:400_000]
        if len(text) > 400_000 and progress_cb:
            progress_cb(
                msg=f"分词器训练用子样本: {len(tok_text)} 字符（原语料 {len(text)}）"
            )
        tok.train(tok_text, cfg.target_vocab_size, special_tokens=list(cfg.special_tokens))
        tok.save(tok_path)
        if progress_cb:
            progress_cb(msg=f"分词器完成，词表 {len(tok.vocab)}，耗时 {time.time() - t0:.1f}s")

    tokens = tok.encode(text)
    if progress_cb:
        progress_cb(msg=f"token 总数: {len(tokens)}")

    # ---------- 训练/验证切分 ----------
    # 从尾部切出验证集；阈值只需保证验证集能撑起 estimate_loss 的采样
    # （eval_iters*batch_size 个窗口），取 max_seq*batch_size 即可，
    # 避免小语料 5% 验证集被错误回退到全量（那样 val 会和 train 同源、形同自测）。
    n_val = int(len(tokens) * val_frac)
    if n_val >= cfg.max_seq * cfg.batch_size and n_val < len(tokens) // 2:
        val_tokens = tokens[len(tokens) - n_val:]
        train_tokens = tokens[: len(tokens) - n_val]
        if progress_cb:
            progress_cb(msg=f"切分验证集: train {len(train_tokens)} / val {len(val_tokens)} token")
    else:
        val_tokens, train_tokens = None, tokens
        if progress_cb:
            progress_cb(msg="验证集过小，本次不切分（val 将与 train 同源）")

    # ---------- 模型 ----------
    cfg.vocab_size = len(tok.vocab)
    model_path = os.path.join(out_dir, "model.pt")
    if os.path.exists(model_path):
        # 断点续训：加载已有权重继续训练（优化器状态不保存，新建即可）
        ckpt = torch.load(model_path, map_location=device)
        saved = {k: v for k, v in ckpt["cfg"].items() if k in GPTConfig.__dataclass_fields__}
        for k, v in saved.items():
            setattr(cfg, k, v)
        cfg.vocab_size = len(tok.vocab)
        model = GPT(cfg, cfg.vocab_size).to(device)
        model.load_state_dict(ckpt["model"])
        n_params = sum(p.numel() for p in model.parameters())
        if progress_cb:
            progress_cb(msg=f"断点续训：已加载权重, 参数量 {n_params / 1e6:.2f}M")
    else:
        model = GPT(cfg, cfg.vocab_size).to(device)
        n_params = sum(p.numel() for p in model.parameters())
        if progress_cb:
            progress_cb(msg=f"模型参数量: {n_params / 1e6:.2f}M")

    optimizer = torch.optim.AdamW(
        model.parameters(), lr=cfg.learning_rate, weight_decay=cfg.weight_decay
    )

    # ---------- 训练循环 ----------
    if progress_cb:
        progress_cb(msg="开始训练...")
    model.train()
    t_start = time.time()
    for it in range(cfg.max_iters):
        if stop_event is not None and stop_event.is_set():
            if progress_cb:
                progress_cb(msg="训练已被用户停止。")
            break

        lr = get_lr(it, cfg)
        for g in optimizer.param_groups:
            g["lr"] = lr

        x, y = get_batch(train_tokens, cfg, device)
        _, loss = model(x, y)

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        clip_grad_norm_(model.parameters(), cfg.grad_clip)
        optimizer.step()

        # 每 10 步给一次轻量进度（不做验证，开销极小），带已用/预计剩余时间
        if it % 10 == 0 and it % cfg.eval_interval != 0:
            elapsed = time.time() - t_start
            eta = elapsed / (it + 1) * (cfg.max_iters - it - 1)
            if progress_cb:
                progress_cb(
                    stage="train",
                    iter=it,
                    total=cfg.max_iters,
                    loss=loss.item(),
                    lr=lr,
                    msg=f"iter {it:5d}/{cfg.max_iters} | train {loss.item():.4f} | "
                        f"lr {lr:.2e} | 已用 {elapsed / 60:.1f}min | 预计剩余 {eta / 60:.1f}min",
                )

        if it % cfg.eval_interval == 0 or it == cfg.max_iters - 1:
            val_loss = estimate_loss(model, val_tokens or tokens, cfg, device)
            if progress_cb:
                progress_cb(
                    stage="train",
                    iter=it,
                    total=cfg.max_iters,
                    loss=loss.item(),
                    val=val_loss,
                    lr=lr,
                    msg=f"iter {it:5d} | train {loss.item():.4f} | "
                        f"val {val_loss:.4f} | lr {lr:.2e}",
                )
            torch.save(
                {"model": model.state_dict(), "cfg": cfg.__dict__},
                os.path.join(out_dir, "model.pt"),
            )

    if progress_cb:
        progress_cb(stage="done", msg=f"训练完成，耗时 {time.time() - t_start:.1f}s，"
                                      f"权重已保存到 {out_dir}")
    return tok, model, cfg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default="data/corpus_mixed.txt")
    parser.add_argument("--out", type=str, default="checkpoints")
    parser.add_argument("--max_iters", type=int, default=None)
    parser.add_argument("--val-frac", type=float, default=0.05,
                        help="验证集占比（从语料尾部切分，训练时不参与）")
    args = parser.parse_args()

    cfg = GPTConfig()
    if args.max_iters is not None:
        cfg.max_iters = args.max_iters

    def _print_cb(**kw):
        if kw.get("msg"):
            print(kw["msg"])

    run_training(cfg, args.data, args.out, progress_cb=_print_cb,
                 val_frac=args.val_frac)


if __name__ == "__main__":
    main()
