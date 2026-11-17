#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_corpus.py — 构建最终训练语料 corpus_final.txt

策略：
  新语料（data/seed + data/seed_aug，约 5 万字符）
    - 全部采用，权重 ×3（相当于 15 万字符），让模型重点学习真实语言结构
  旧语料（data/corpus_zh.txt + data/corpus_mixed.txt，约 360 万字符）
    - 清洗：全量去重、过滤超短行、过滤含 URL/邮箱的行
    - 采样 15 万字符，提供字频与句式多样性
  混合：新旧按 1:1 权重交替交错（段级），避免新旧语料各自成块
  输出：data/corpus_final.txt + 统计报告
"""
import os
import re
import glob
import random

random.seed(2026)

NEW_DIRS = ["data/seed", "data/seed_aug"]
OLD_FILES = ["data/corpus_zh.txt", "data/corpus_mixed.txt"]
OUT = "data/corpus_final.txt"

NEW_REPEAT = 3          # 新语料重复权重
OLD_TARGET_CHARS = 150_000  # 旧语料采样目标字符数
MIN_LINE = 15           # 旧语料最短行过滤


def load_new():
    paras = []
    for d in NEW_DIRS:
        for f in sorted(glob.glob(os.path.join(d, "*.txt"))):
            with open(f, encoding="utf-8") as g:
                paras += [p.strip() for p in g.read().split("\n") if p.strip()]
    return paras


def clean_old():
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
    return lines


def main():
    new_paras = load_new()
    print("新语料段数: %d（去重前）" % len(new_paras))
    # 新语料内部去重
    seen = set()
    new_unique = []
    for p in new_paras:
        if p not in seen:
            seen.add(p)
            new_unique.append(p)
    print("新语料段数: %d（去重后）" % len(new_unique))

    old_lines = clean_old()
    print("旧语料行数: %d（清洗去重后，原 %d 字符）"
          % (len(old_lines), sum(len(l) for l in old_lines)))

    # 旧语料采样到目标字符数
    random.shuffle(old_lines)
    old_sampled, total = [], 0
    for l in old_lines:
        if total >= OLD_TARGET_CHARS:
            break
        old_sampled.append(l)
        total += len(l)
    print("旧语料采样: %d 行 / %d 字符" % (len(old_sampled), total))

    # 新语料按权重展开
    new_pool = new_unique * NEW_REPEAT
    new_chars = sum(len(p) for p in new_unique) * NEW_REPEAT
    print("新语料展开: %d 段 / %d 字符（权重 ×%d）" % (len(new_pool), new_chars, NEW_REPEAT))

    # 交错混合：按 1:1 字符比例交替放入，段级 shuffle
    random.shuffle(new_pool)
    random.shuffle(old_sampled)
    out = []
    ni = oi = 0
    turn_new = True
    while ni < len(new_pool) or oi < len(old_sampled):
        if turn_new and ni < len(new_pool):
            out.append(new_pool[ni]); ni += 1
        elif not turn_new and oi < len(old_sampled):
            out.append(old_sampled[oi]); oi += 1
        elif ni < len(new_pool):
            out.append(new_pool[ni]); ni += 1
        else:
            out.append(old_sampled[oi]); oi += 1
        turn_new = not turn_new

    with open(OUT, "w", encoding="utf-8") as g:
        g.write("\n".join(out) + "\n")

    final_chars = sum(len(p) + 1 for p in out)
    print()
    print("==== 构建完成 ====")
    print("输出文件: %s" % OUT)
    print("总段数: %d（新 %d + 旧 %d）" % (len(out), ni, oi))
    print("总字符数: %d（约 %.1f 万）" % (final_chars, final_chars / 10000))
    print("新旧字符比: %.0f%% : %.0f%%"
          % (100 * new_chars / (new_chars + total), 100 * total / (new_chars + total)))


if __name__ == "__main__":
    main()
