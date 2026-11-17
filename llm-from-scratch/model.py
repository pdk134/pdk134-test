"""
从零实现的 GPT 风格 Decoder-only Transformer。

自实现的组件（不调用任何预训练模型 / 现成实现）：
  - RMSNorm        : 代替 LayerNorm 的归一化（Llama 风格）
  - RoPE           : 旋转位置编码，把位置信息编码进 Q/K
  - Causal MHA     : 因果多头自注意力（带 RoPE、因果掩码）
  - SwiGLU FFN     : 前馈层（Silu 门控）
  - TransformerBlock / GPT : 堆叠 + 权重共享的 LM 头

PyTorch 仅用于张量运算与自动求导，模型结构完全手写。
"""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class RMSNorm(nn.Module):
    """Root Mean Square Layer Normalization。"""

    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        ms = x.pow(2).mean(-1, keepdim=True)
        x = x * torch.rsqrt(ms + self.eps)
        return self.weight * x


class RotaryEmbedding(nn.Module):
    """旋转位置编码（RoPE）。预先计算不同频率的 cos/sin。"""

    def __init__(self, dim: int, base: float = 10000.0):
        super().__init__()
        assert dim % 2 == 0, "RoPE 维度必须为偶数"
        self.dim = dim
        # 每个维度的频率： 1 / base^(2i/dim)
        inv_freq = 1.0 / (base ** (torch.arange(0, dim, 2).float() / dim))
        self.register_buffer("inv_freq", inv_freq)

    def forward(self, seq_len: int, device):
        t = torch.arange(seq_len, device=device).float()
        freqs = torch.outer(t, self.inv_freq)          # (T, dim/2)
        emb = torch.cat((freqs, freqs), dim=-1)         # (T, dim)
        return emb.cos(), emb.sin()


def rotate_half(x):
    half = x.shape[-1] // 2
    x1, x2 = x[..., :half], x[..., half:]
    return torch.cat((-x2, x1), dim=-1)


def apply_rope(q, k, cos, sin):
    """对 Q/K 施加旋转。q,k: (B, H, T, D)；cos,sin: (T, D)。"""
    cos = cos.unsqueeze(0).unsqueeze(0)  # (1,1,T,D)
    sin = sin.unsqueeze(0).unsqueeze(0)
    q = q * cos + rotate_half(q) * sin
    k = k * cos + rotate_half(k) * sin
    return q, k


class CausalMultiHeadAttention(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.n_heads = cfg.n_heads
        self.head_dim = cfg.d_model // cfg.n_heads
        self.scale = 1.0 / math.sqrt(self.head_dim)
        # 一次算出 Q/K/V
        self.qkv = nn.Linear(cfg.d_model, 3 * cfg.d_model, bias=cfg.bias)
        self.proj = nn.Linear(cfg.d_model, cfg.d_model, bias=cfg.bias)
        self.rope = RotaryEmbedding(self.head_dim, base=cfg.rope_base)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x):
        B, T, C = x.shape
        qkv = self.qkv(x).split(C, dim=-1)  # 3 * (B, T, C)

        def split_heads(t):
            return t.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)

        q, k, v = (split_heads(t) for t in qkv)  # 各 (B, H, T, D)

        cos, sin = self.rope(T, x.device)
        q, k = apply_rope(q, k, cos, sin)

        # 缩放点积注意力
        scores = (q @ k.transpose(-2, -1)) * self.scale  # (B, H, T, T)
        # 因果掩码：屏蔽未来位置
        mask = torch.triu(
            torch.ones(T, T, dtype=torch.bool, device=x.device), diagonal=1
        )
        scores = scores.masked_fill(mask, float("-inf"))
        attn = F.softmax(scores, dim=-1)
        attn = self.drop(attn)

        out = attn @ v                       # (B, H, T, D)
        out = out.transpose(1, 2).contiguous().view(B, T, C)
        out = self.proj(out)
        out = self.drop(out)
        return out


class SwiGLUFeedForward(nn.Module):
    """SwiGLU 前馈层： silu(W1 x) * (W2 x) 再经 W3 投影。"""

    def __init__(self, cfg):
        super().__init__()
        hid = int(cfg.d_model * cfg.ff_mult)
        self.fc1 = nn.Linear(cfg.d_model, hid, bias=cfg.bias)
        self.fc2 = nn.Linear(cfg.d_model, hid, bias=cfg.bias)
        self.fc3 = nn.Linear(hid, cfg.d_model, bias=cfg.bias)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x):
        return self.drop(self.fc3(F.silu(self.fc1(x)) * self.fc2(x)))


class TransformerBlock(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.ln1 = RMSNorm(cfg.d_model)
        self.attn = CausalMultiHeadAttention(cfg)
        self.ln2 = RMSNorm(cfg.d_model)
        self.ff = SwiGLUFeedForward(cfg)

    def forward(self, x):
        x = x + self.attn(self.ln1(x))   # 残差 1
        x = x + self.ff(self.ln2(x))     # 残差 2
        return x


class GPT(nn.Module):
    def __init__(self, cfg, vocab_size: int):
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(vocab_size, cfg.d_model)
        self.blocks = nn.ModuleList(
            [TransformerBlock(cfg) for _ in range(cfg.n_layers)]
        )
        self.ln_f = RMSNorm(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, vocab_size, bias=False)
        # 权重共享：embedding 与输出层共用参数（经典做法，省参且更稳定）
        self.lm_head.weight = self.tok_emb.weight

        self.apply(self._init_weights)

    def _init_weights(self, module):
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(self, idx, targets=None):
        B, T = idx.shape
        x = self.tok_emb(idx)                      # (B, T, d_model)
        for block in self.blocks:
            x = block(x)
        x = self.ln_f(x)
        logits = self.lm_head(x)                   # (B, T, vocab)

        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)), targets.view(-1)
            )
        return logits, loss
