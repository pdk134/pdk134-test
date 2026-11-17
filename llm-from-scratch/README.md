# 从零实现的 LLM（GPT 风格）

不调用任何现成预训练模型 / tokenizer 库，全部**手写**：

- `tokenizer.py` — Byte-Level BPE 分词器（参考 GPT-2 思路，自己实现训练与编解码）
- `model.py` — GPT Decoder-only Transformer，自实现：
  - `RMSNorm` 归一化
  - `RoPE` 旋转位置编码
  - 因果多头自注意力（Causal Multi-Head Attention）
  - `SwiGLU` 前馈层
  - 权重共享的 LM 头
- `train.py` — 训练（AdamW + 余弦学习率 + warmup + 梯度裁剪 + 断点保存）
- `generate.py` — 自回归生成（temperature / top-k / top-p 采样）
- `config.py` — 超参数

PyTorch 仅用于张量与自动求导，模型结构完全自己写。

## 环境

```bash
pip install -r requirements.txt
```

## 训练

```bash
# 用内置示例语料（自动生成）跑通流程
python train.py

# 用你自己的文本（UTF-8）训练
python train.py --data your_corpus.txt

# 加大训练量 / 从断点续训
python train.py --max_iters 5000
python train.py --resume
```

训练产物在 `checkpoints/`：`tokenizer.json` 与 `model.pt`。

## 生成

```bash
python generate.py --prompt "The old library" --max_new 300 --temperature 0.8
```

## 调参建议

在 `config.py` 里改：

| 参数 | 说明 |
|------|------|
| `d_model` | 隐藏维度，需能被 `n_heads` 整除 |
| `n_layers` | Transformer 层数（越大越强，越慢） |
| `n_heads` | 注意力头数（`d_model/n_heads` 需为偶数，供 RoPE） |
| `target_vocab_size` | 分词器目标词表大小 |
| `max_seq` | 上下文长度 |

> 想训出"像样"的效果，需要 GPU + 较大语料（建议百万字以上），并相应增大 `d_model / n_layers / max_iters`。

## 数据流示意

```
文本 -> [BPE 分词] -> token ids
                         |
                         v
token ids -> Embedding -> [Block x N] -> RMSNorm -> LM Head -> logits
   Block = 残差(RoPE因果注意力) + 残差(SwiGLU)
                         |
                         v
        cross_entropy(logits, next_token) 反向传播更新参数
```
