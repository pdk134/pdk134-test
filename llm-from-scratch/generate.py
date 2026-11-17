"""
生成（推理）模块：加载训练好的分词器与模型，做自回归生成。

既可以直接命令行运行（见下方用法），也暴露 generate() 供 GUI 客户端调用，
支持 temperature / top-k / top-p 采样，并可按 token 流式回调。
"""
import argparse

import torch

from config import GPTConfig
from model import GPT
from tokenizer import BPETokenizer


def generate(
    tok,
    model,
    cfg,
    prompt,
    max_new=200,
    temperature=0.8,
    top_k=50,
    top_p=0.9,
    seed=0,
    step_callback=None,
    repetition_penalty=1.1,
    rep_window=64,
    stop=None,
):
    """自回归生成。

    step_callback(continuation_text) 会在每生成一个 token 后被调用，
    传入到目前为止「除去 prompt 的」续写文本，便于流式显示。
    返回完整文本（含 prompt）。
    """
    device = next(model.parameters()).device
    torch.manual_seed(seed)

    ids = tok.encode(prompt)
    generated = ids[:]

    last_cont = ""
    stopped = False

    with torch.no_grad():
        for _ in range(max_new):
            ctx = torch.tensor(
                generated[-cfg.max_seq:], dtype=torch.long, device=device
            ).unsqueeze(0)
            logits, _ = model(ctx)
            logits = logits[0, -1, :]
            # 重复惩罚：抑制最近出现过的 token，缓解"车轱辘话"
            if repetition_penalty != 1.0:
                for tid in set(generated[-rep_window:]):
                    if logits[tid] > 0:
                        logits[tid] /= repetition_penalty
                    else:
                        logits[tid] *= repetition_penalty
            logits = logits / max(temperature, 1e-6)

            # top-k 截断
            if top_k > 0:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[-1]] = float("-inf")

            # top-p（核）截断
            if top_p < 1.0:
                sorted_logits, sorted_idx = torch.sort(logits, descending=True)
                probs = torch.softmax(sorted_logits, dim=-1)
                cum = torch.cumsum(probs, dim=-1)
                remove = cum > top_p
                remove[0] = False  # 始终保留概率最高的 token，避免全部被裁掉
                sorted_logits[remove] = float("-inf")
                logits = torch.zeros_like(logits).scatter(0, sorted_idx, sorted_logits)

            probs = torch.softmax(logits, dim=-1)
            next_id = torch.multinomial(probs, 1).item()
            generated.append(next_id)

            # 只解码新生成的部分
            cont = tok.decode(generated[len(ids):])

            # 早停：一旦续写中出现任一停止串（如新一轮的 "你:"），立即截断并停止
            cut = None
            if stop:
                for s in stop:
                    idx = cont.find(s)
                    if idx != -1:
                        cut = idx if cut is None else min(cut, idx)
                if cut is not None:
                    cont = cont[:cut]

            last_cont = cont
            if step_callback is not None:
                step_callback(cont)
            if cut is not None:
                stopped = True
                break

    if stopped:
        return prompt + last_cont
    return tok.decode(generated)


def load_model(ckpt_dir, device):
    """从检查点目录加载 (tokenizer, model, cfg)。"""
    tok = BPETokenizer.load(f"{ckpt_dir}/tokenizer.json")
    ckpt = torch.load(f"{ckpt_dir}/model.pt", map_location=device)
    cfg = GPTConfig(
        **{k: v for k, v in ckpt["cfg"].items() if k in GPTConfig.__dataclass_fields__}
    )
    model = GPT(cfg, cfg.vocab_size)
    model.load_state_dict(ckpt["model"])
    model.to(device).eval()
    return tok, model, cfg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ckpt", type=str, default="checkpoints")
    parser.add_argument("--prompt", type=str, default="The")
    parser.add_argument("--max_new", type=int, default=200)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top_k", type=int, default=50)
    parser.add_argument("--top_p", type=float, default=0.9)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--rep", type=float, default=1.1, help="重复惩罚(>1 抑制复读)")
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok, model, cfg = load_model(args.ckpt, device)

    print(f"prompt: {args.prompt!r}\n--- 生成开始 ---")
    text = generate(
        tok,
        model,
        cfg,
        args.prompt,
        max_new=args.max_new,
        temperature=args.temperature,
        top_k=args.top_k,
        top_p=args.top_p,
        seed=args.seed,
        repetition_penalty=args.rep,
    )
    print(text)


if __name__ == "__main__":
    main()
