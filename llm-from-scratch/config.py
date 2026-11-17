"""模型与训练的超参数配置（全部从零实现，无预训练权重）。"""
from dataclasses import dataclass


@dataclass
class GPTConfig:
    # ===== 模型结构 (GPT 风格 Decoder-only Transformer) =====
    d_model: int = 256          # 隐藏维度，必须能被 n_heads 整除
    n_layers: int = 4           # Transformer Block 层数
    n_heads: int = 4            # 注意力头数（d_model / n_heads 需为偶数，供 RoPE 使用）
    ff_mult: int = 4            # 前馈层隐层倍数（SwiGLU）
    dropout: float = 0.0        # dropout（小数据可设为 0）
    bias: bool = False          # Linear 是否带偏置（GPT-2 风格通常 False）
    rope_base: float = 10000.0  # RoPE 的 base 频率
    max_seq: int = 128          # 训练/推理的最大上下文长度

    # vocab_size 在运行时由分词器词表大小覆盖
    vocab_size: int = 0

    # ===== 训练超参 =====
    batch_size: int = 16
    learning_rate: float = 1e-3
    weight_decay: float = 0.01
    max_iters: int = 1000
    eval_interval: int = 100
    eval_iters: int = 20
    grad_clip: float = 1.0
    warmup_iters: int = 100

    # ===== 分词器 =====
    target_vocab_size: int = 8000   # 中文需要更大的词表才能学出子词
    special_tokens: tuple = ("<|endoftext|>",)
