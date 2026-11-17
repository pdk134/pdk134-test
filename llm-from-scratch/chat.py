"""
命令行交互式聊天：加载手写的 GPT 聊天模型，多轮与人对话。

这是经过「对话语料」训练的聊天模型（next-token 续写，但学会了
"用户：/助手：" 的对话格式），能以角色身份自然接话、多轮来回。

用法：
  python chat.py                      # 加载 checkpoints/chat 后进入交互
  python chat.py --ckpt checkpoints/chat
  python chat.py --maxn 80 --temp 0.85

进入后：
  直接输入文字并回车  -> 模型以「助手」身份回复
  /reset             -> 清空对话上下文
  /temp 0.85         -> 设置温度
  /topk 40           -> 设置 top_k
  /topp 0.9          -> 设置 top_p
  /rep 1.15          -> 设置重复惩罚
  /maxn 80           -> 设置本次生成长度
  /help              -> 查看命令
  /quit|/exit        -> 退出

说明（现实边界）：模型仅 6.24M 参数、上下文 128 token、在约 14 万字符
中英文对话+叙述语料上训练，能进行连贯、像样的短对话，但不具备真实的理解、
记忆与世界知识。它是「像聊天一样接话」，而非真正像人一样思考。
"""
import argparse
import os
import sys

import torch

# 强制 stdout 使用 UTF-8，避免 Windows(GBK) 控制台打印中文/特殊字符时报错
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import generate as gen
from config import GPTConfig

CKPT_DIR = "checkpoints/chat"          # 聊天模型默认目录
USER_TAG = "用户："                     # 用户轮标记（与训练语料一致）
ASST_TAG = "助手："                     # 助手轮标记（与训练语料一致）


def print_help():
    print(
        "\n命令：\n"
        "  /reset      清空对话上下文\n"
        "  /temp  <v>  温度 (默认 0.85)\n"
        "  /topk  <v>  top_k (默认 40, 0=关闭)\n"
        "  /topp  <v>  top_p (默认 0.9, 1.0=关闭)\n"
        "  /maxn  <v>  生成长度 (默认 80)\n"
        "  /rep   <v>  重复惩罚 (默认 1.15, 1.0=关闭)\n"
        "  /help       显示本帮助\n"
        "  /quit|/exit 退出\n"
        "直接输入文字即可让模型以助手身份回复。\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=CKPT_DIR)
    ap.add_argument("--temp", type=float, default=0.85)
    ap.add_argument("--topk", type=int, default=40)
    ap.add_argument("--topp", type=float, default=0.9)
    ap.add_argument("--maxn", type=int, default=80)
    ap.add_argument("--rep", type=float, default=1.15, help="重复惩罚(>1 抑制复读)")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if not (os.path.exists(f"{args.ckpt}/tokenizer.json") and os.path.exists(f"{args.ckpt}/model.pt")):
        print(f"未找到 {args.ckpt} 下的聊天模型。请先运行训练：\n"
              f"  python train.py --data data/corpus_chat.txt --out checkpoints/chat --max_iters 1500")
        sys.exit(1)

    tok, model, cfg = gen.load_model(args.ckpt, device)

    temp, top_k, top_p, max_n, rep = args.temp, args.topk, args.topp, args.maxn, args.rep

    print("=" * 60)
    print("  从零 LLM · 中文聊天  (输入 /help 查看命令, /quit 退出)")
    print("=" * 60)

    context = ""  # 累积的对话上下文（模型只取最后 max_seq 个 token）
    while True:
        try:
            user = input("\n用户> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            break

        if not user:
            continue
        if user in ("/quit", "/exit"):
            print("助手> 再见啦，记得照顾好自己。下次见。")
            break
        if user == "/help":
            print_help()
            continue
        if user == "/reset":
            context = ""
            print("[上下文已清空]")
            continue
        if user.startswith("/temp"):
            try:
                temp = float(user.split()[1]); print(f"[温度 -> {temp}]")
            except Exception:
                print("[用法: /temp 0.85]")
            continue
        if user.startswith("/topk"):
            try:
                top_k = int(user.split()[1]); print(f"[top_k -> {top_k}]")
            except Exception:
                print("[用法: /topk 40]")
            continue
        if user.startswith("/topp"):
            try:
                top_p = float(user.split()[1]); print(f"[top_p -> {top_p}]")
            except Exception:
                print("[用法: /topp 0.9]")
            continue
        if user.startswith("/maxn"):
            try:
                max_n = int(user.split()[1]); print(f"[生成长度 -> {max_n}]")
            except Exception:
                print("[用法: /maxn 80]")
            continue
        if user.startswith("/rep"):
            try:
                rep = float(user.split()[1]); print(f"[重复惩罚 -> {rep}]")
            except Exception:
                print("[用法: /rep 1.15]")
            continue

        # ---- 构造 prompt：把历史上下文 + 本轮用户发言 + 助手前缀 拼起来 ----
        prompt = context + USER_TAG + user + "\n" + ASST_TAG
        print("助手> ", end="", flush=True)

        shown = 0

        def step(cont):
            nonlocal shown
            delta = cont[shown:]
            shown = len(cont)
            print(delta, end="", flush=True)

        full = gen.generate(
            tok, model, cfg, prompt,
            max_new=max_n, temperature=temp,
            top_k=top_k, top_p=top_p,
            repetition_penalty=rep, step_callback=step,
            # 早停：一旦续写里出现新一轮的"用户："或"助手："标记，立即截断
            stop=["\n" + USER_TAG, "\n" + ASST_TAG],
        )
        print()  # 换行

        # 取出本轮「助手」的回复：截断到下一个角色标记之前
        cont = full[len(prompt):]
        reply = cont.split("\n" + USER_TAG)[0].split("\n" + ASST_TAG)[0].strip()
        # 更新上下文，供下一轮参考（生成时内部只取最后 max_seq 个 token）
        context = prompt + reply + "\n"


if __name__ == "__main__":
    main()
