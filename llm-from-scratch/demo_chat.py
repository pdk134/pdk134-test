#!/usr/bin/env python3
"""干净的聊天演示：用和 chat.py 完全相同的生成逻辑，按固定输入跑多轮，
清晰展示「用户/助手」对话，便于评估效果（避免交互提示符噪音）。"""
import sys
import torch

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import generate as gen

CKPT = "checkpoints/chat"
USER_TAG, ASST_TAG = "用户：", "助手："

tok, model, cfg = gen.load_model(CKPT, "cpu")

context = ""
scripted = [
    "你好",
    "你叫什么名字",
    "你是真人吗",
    "我有点累",
    "讲个笑话",
    "怎么缓解压力",
    "再见",
]

for user in scripted:
    prompt = context + USER_TAG + user + "\n" + ASST_TAG
    full = gen.generate(
        tok, model, cfg, prompt,
        max_new=80, temperature=0.85, top_k=40, top_p=0.9,
        repetition_penalty=1.15,
        stop=["\n" + USER_TAG, "\n" + ASST_TAG],
    )
    cont = full[len(prompt):]
    reply = cont.split("\n" + USER_TAG)[0].split("\n" + ASST_TAG)[0].strip()
    context = prompt + reply + "\n"
    print(f"{USER_TAG}{user}")
    print(f"{ASST_TAG}{reply}\n")
