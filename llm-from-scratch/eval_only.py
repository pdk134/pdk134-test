#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_only.py — 不重训，直接评估已保存的两个 checkpoint。

模型 A: checkpoints/final  (语料 corpus_final.txt：新种子15万 + 旧清洗15万, 1:1)
模型 B: checkpoints/old    (语料 corpus_old_baseline.txt：纯旧语料30万)

指标：
  - 各自语料尾部 5% 验证集上的 val loss（真实泛化能力）
  - 训练集上的 train loss（与 val 对比看过拟合/欠拟合）
  - 相同 prompt 各生成样本（质量定性对比）
关键修复：torch 线程数降到 4，避免小模型上线程过度订阅导致生成极慢。
"""
import os
import json
import torch

torch.set_num_threads(4)

from config import GPTConfig
from train import estimate_loss
from tokenizer import BPETokenizer
from generate import load_model, generate

OUT_A = "checkpoints/final"
OUT_B = "checkpoints/old"
DATA_A = "data/corpus_final.txt"
DATA_B = "data/corpus_old_baseline.txt"
VAL_FRAC = 0.05

PROMPTS = ["人工智能", "春天来了，", "他说：", "学习是一件", "大海"]


def load_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def split_train_val(tok, text, cfg):
    tokens = tok.encode(text)
    n_val = int(len(tokens) * VAL_FRAC)
    # 阈值只需保证验证集能撑起 estimate_loss 的采样（eval_iters*batch_size 个窗口）：
    # 取 max_seq * batch_size 即可，避免小语料 5% 验证集被错误回退到全量。
    if n_val >= cfg.max_seq * cfg.batch_size and n_val < len(tokens) // 2:
        val = tokens[len(tokens) - n_val:]
        tr = tokens[: len(tokens) - n_val]
    else:
        val, tr = None, tokens
    return tr, val, len(tokens)


def evaluate(out_dir, data_path):
    device = "cpu"
    tok, model, cfg = load_model(out_dir, device)
    text = load_text(data_path)
    tr, val, n_tok = split_train_val(tok, text, cfg)
    train_loss = estimate_loss(model, tr, cfg, device)
    val_loss = estimate_loss(model, val, cfg, device) if val is not None else None
    samples = []
    for p in PROMPTS:
        text_out = generate(tok, model, cfg, p, max_new=120,
                            temperature=0.8, top_k=50, top_p=0.9, seed=0)
        samples.append({"prompt": p, "text": text_out})
    return {
        "checkpoint": out_dir,
        "data": data_path,
        "n_tokens": n_tok,
        "train_loss": round(train_loss, 4),
        "val_loss": round(val_loss, 4) if val_loss is not None else None,
        "samples": samples,
    }


def main():
    res_a = evaluate(OUT_A, DATA_A)
    res_b = evaluate(OUT_B, DATA_B)
    result = {"val_frac": VAL_FRAC, "model_final": res_a, "model_old": res_b}
    with open("compare_results.json", "w", encoding="utf-8") as g:
        json.dump(result, g, ensure_ascii=False, indent=2)
    print("==== 评估完成 ====")
    print(f"[A 交付语料] train_loss={res_a['train_loss']}  val_loss={res_a['val_loss']}")
    print(f"[B 旧语料 ] train_loss={res_b['train_loss']}  val_loss={res_b['val_loss']}")


if __name__ == "__main__":
    main()
