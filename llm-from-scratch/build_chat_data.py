#!/usr/bin/env python3
"""构建聊天模型训练语料：高质量叙述种子(保流畅) + 对话语料(学对话格式,加权)。
把对话语料放在前面，保证分词器(只采样前 40 万字符)也能学到对话字符组合。
输出 data/corpus_chat.txt
"""
import os, glob

base = "data"
seeds = sorted(glob.glob(f"{base}/seed/*.txt")) + sorted(glob.glob(f"{base}/seed_aug/*.txt"))
narr = []
for p in seeds:
    narr.append(open(p, encoding="utf-8").read())
narr = "\n".join(narr)

chat = open(f"{base}/chat_corpus.txt", encoding="utf-8").read().strip()
para = open(f"{base}/chat_paraphrases.txt", encoding="utf-8").read().strip()
# 同义改写簇权重最高(专门教"按意图而非原话接话")；原对话语料降重复(减死记硬背)
N_CHAT, N_PARA = 2, 4

# 对话在前(分词器可见)，叙述在后(保流畅)
out = "\n".join([chat] * N_CHAT + [para] * N_PARA + [narr])

path = f"{base}/corpus_chat.txt"
open(path, "w", encoding="utf-8").write(out)
print(f"写出 {path}")
print(f"  原对话语料: {len(chat)} × {N_CHAT}")
print(f"  同义改写簇: {len(para)} × {N_PARA}")
print(f"  叙述种子:   {len(narr)} × 1")
print(f"  合计: {len(out)} 字符, 对话占比约 {(len(chat)*N_CHAT+len(para)*N_PARA)/len(out)*100:.1f}%")
