#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compare_corpora.py — 对比新旧语料训练效果

基线 (A): data/corpus_final.txt  —— 交付语料（新种子 15万 + 旧清洗 15万，1:1）
对照 (B): data/corpus_old_baseline.txt —— 纯旧语料清洗后采样 30万字符

两模型结构/超参完全一致，唯一变量是语料内容质量。
记录 train/val 损失曲线，并用相同 prompt 各生成样本做质量对比。
"""
import os
import re
import json
import glob
import random

import torch

from config import GPTConfig
from train import run_training
from generate import load_model, generate

OUT_DIR_A = "checkpoints/final"
OUT_DIR_B = "checkpoints/old"
BASELINE_OLD = "data/corpus_old_baseline.txt"
OLD_FILES = ["data/corpus_zh.txt", "data/corpus_mixed.txt"]
OLD_TARGET_CHARS = 300_000
MIN_LINE = 15
MAX_ITERS = 600
VAL_FRAC = 0.05

PROMPTS = ["人工智能", "春天来了，", "他说：", "学习是一件", "大海"]


def build_old_baseline():
    """复用 build_corpus 的清洗逻辑，但只取旧语料并采样到目标字符数。"""
    seen = set()
    lines = []
    url_pat = re.compile(r"(https?://|www\.|@\w+\.\w+)")
    for f in OLD_FILES:
        if not os.path.exists(f):
            continue
        with open(f, encoding="utf-8") as g:
            for raw in g:
                line = raw.strip()
                if len(line) < MIN_LINE:
                    continue
                if url_pat.search(line):
                    continue
                if line in seen:
                    continue
                seen.add(line)
                lines.append(line)
    random.seed(2026)
    random.shuffle(lines)
    sampled, total = [], 0
    for l in lines:
        if total >= OLD_TARGET_CHARS:
            break
        sampled.append(l)
        total += len(l)
    with open(BASELINE_OLD, "w", encoding="utf-8") as g:
        g.write("\n".join(sampled) + "\n")
    print(f"[baseline] 旧语料清洗后采样 {len(sampled)} 行 / {total} 字符 -> {BASELINE_OLD}")
    return total


def run_one(tag, data_path, out_dir):
    cfg = GPTConfig()
    cfg.max_iters = MAX_ITERS
    cfg.eval_interval = 100
    curve = []

    def cb(**kw):
        if kw.get("stage") == "train" and "val" in kw:
            curve.append({
                "iter": kw["iter"],
                "train": round(kw["loss"], 4),
                "val": round(kw["val"], 4),
            })

    run_training(cfg, data_path, out_dir, progress_cb=cb, val_frac=VAL_FRAC)
    return curve


def gen_samples(out_dir, tag):
    device = "cpu"
    tok, model, cfg = load_model(out_dir, device)
    samples = []
    for p in PROMPTS:
        text = generate(tok, model, cfg, p, max_new=120,
                        temperature=0.8, top_k=50, top_p=0.9, seed=0)
        samples.append({"prompt": p, "text": text})
    return samples


def main():
    random.seed(2026)
    os.makedirs("checkpoints", exist_ok=True)

    print("== 步骤 1/4 构建旧语料基线 ==")
    old_chars = build_old_baseline()

    print("== 步骤 2/4 训练模型 A（交付语料 corpus_final.txt）==")
    curve_a = run_one("A", "data/corpus_final.txt", OUT_DIR_A)

    print("== 步骤 3/4 训练模型 B（纯旧语料基线）==")
    curve_b = run_one("B", BASELINE_OLD, OUT_DIR_B)

    print("== 步骤 4/4 生成对比样本 ==")
    samples_a = gen_samples(OUT_DIR_A, "A")
    samples_b = gen_samples(OUT_DIR_B, "B")

    result = {
        "config": {"max_iters": MAX_ITERS, "val_frac": VAL_FRAC,
                   "old_baseline_chars": old_chars},
        "curve_final": curve_a,
        "curve_old": curve_b,
        "samples_final": samples_a,
        "samples_old": samples_b,
    }
    with open("compare_results.json", "w", encoding="utf-8") as g:
        json.dump(result, g, ensure_ascii=False, indent=2)
    print("\n==== 完成，结果写入 compare_results.json ====")


if __name__ == "__main__":
    main()
