"""
从零实现的 Byte-Level BPE 分词器（参考 GPT-2 思路，但全部自己写）。

流程：
  1. 用正则把文本切成「预分词单元」（单词 / 数字 / 标点 / 空白）
  2. 每个单元按 UTF-8 字节映射到可见 Unicode 字符（byte-level，避免未登录字节）
  3. 在所有单元上做贪婪 BPE 合并，学习 merges 规则
  4. encode 时复用 merges 把新文本切成子词；decode 再映射回字节

完全不依赖任何现成的 tokenizer 库（如 sentencepiece / tiktoken）。
"""
import json
import re
from collections import Counter, defaultdict

import regex as re  # 支持 \p{L} 等 Unicode 属性


def bytes_to_unicode():
    """构造 256 个字节 -> 可见字符 的映射（GPT-2 同款）。"""
    bs = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(ord("¡"), ord("¬") + 1))
        + list(range(ord("®"), ord("ÿ") + 1))
    )
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


# GPT-2 的预分词正则：先匹配缩写，再按「词/数字/标点/空白」切分
PRETOKEN_PATTERN = (
    r"""'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+"""
)


class BPETokenizer:
    def __init__(self, pattern: str = PRETOKEN_PATTERN):
        self.pattern = pattern
        self.byte_encoder = bytes_to_unicode()
        self.byte_decoder = {v: k for k, v in self.byte_encoder.items()}

        self.special_tokens = {}     # token_str -> id
        self.special_token_set = set()
        self.merges = {}             # (a, b) -> rank（越小越优先合并）
        self.vocab = {}              # symbol_str -> id
        self.id_to_token = {}        # id -> symbol_str

    # ------------------------------------------------------------------
    # 训练：从语料学习 BPE 合并规则
    # ------------------------------------------------------------------
    def train(self, text: str, vocab_size: int, special_tokens=None):
        special_tokens = list(special_tokens or [])
        self.special_tokens = {s: i for i, s in enumerate(special_tokens)}
        self.special_token_set = set(self.special_tokens.keys())

        # 1) 预分词 + 去重计频（巨大的加速：相同词只处理一次）
        counter = Counter()
        for word in re.findall(self.pattern, text):
            syms = tuple(self.byte_encoder[b] for b in word.encode("utf-8"))
            counter[syms] += 1
        word_symbols = [list(k) for k in counter.keys()]
        word_freq = list(counter.values())

        # 2) 基础词表：256 个字节字符 + 特殊 token
        self.vocab = {}
        nid = 0
        for i in range(256):
            ch = self.byte_encoder[i]
            self.vocab[ch] = nid
            nid += 1
        for s in special_tokens:
            self.vocab[s] = nid
            nid += 1

        # 3) 统计所有相邻符号对的出现频次，并建立 pair -> 包含它的词索引集合
        pair_counts = Counter()
        pair_to_words = defaultdict(set)
        for widx, (syms, f) in enumerate(zip(word_symbols, word_freq)):
            for i in range(len(syms) - 1):
                p = (syms[i], syms[i + 1])
                pair_counts[p] += f
                pair_to_words[p].add(widx)

        # 4) 贪婪合并：每轮选频次最高的 pair 合并成一个新符号
        #    用最大堆维护最高频 pair，避免每轮全量扫描（中文唯一词多时尤其关键）
        import heapq

        heap = [(-f, p) for p, f in pair_counts.items() if f > 0]
        heapq.heapify(heap)

        merges = {}
        merge_count = 0
        rebuild_every = 256  # 周期性重建堆，丢弃过期条目，避免堆无限膨胀
        while len(self.vocab) < vocab_size and heap:
            negf, best = heapq.heappop(heap)
            f = -negf
            if pair_counts.get(best, 0) != f:
                continue  # 过期条目（频率已变化），跳过
            if f <= 0:
                break
            a, b = best
            m = a + b
            merges[best] = len(merges)
            self.vocab[m] = nid
            nid += 1

            # 只在包含 best 的词上更新，增量维护 pair_counts / pair_to_words
            for widx in list(pair_to_words.get(best, [])):
                syms = word_symbols[widx]
                fq = word_freq[widx]
                # 先删掉该词所有旧 pair
                for i in range(len(syms) - 1):
                    p = (syms[i], syms[i + 1])
                    pair_counts[p] -= fq
                    pair_to_words[p].discard(widx)
                # 合并 best（从左到右、不重叠）
                new_syms = []
                i = 0
                while i < len(syms):
                    if i < len(syms) - 1 and syms[i] == a and syms[i + 1] == b:
                        new_syms.append(m)
                        i += 2
                    else:
                        new_syms.append(syms[i])
                        i += 1
                word_symbols[widx] = new_syms
                # 加入该词的新 pair，并把更新后的频次压回堆（旧条目靠惰性删除跳过）
                for i in range(len(new_syms) - 1):
                    p = (new_syms[i], new_syms[i + 1])
                    pair_counts[p] += fq
                    pair_to_words[p].add(widx)
                    heapq.heappush(heap, (-pair_counts[p], p))

            pair_counts.pop(best, None)
            pair_to_words.pop(best, None)

            merge_count += 1
            if merge_count % rebuild_every == 0:
                print(f"  分词器: 已学习 {len(merges)} 条合并规则，词表大小 {len(self.vocab)}")
                heap = [(-f, p) for p, f in pair_counts.items() if f > 0]
                heapq.heapify(heap)

        self.merges = merges
        self.id_to_token = {v: k for k, v in self.vocab.items()}

    # ------------------------------------------------------------------
    # 编码 / 解码
    # ------------------------------------------------------------------
    def _bpe(self, token: str):
        """把一个预分词单元（已是 byte-level 字符序列）按 merges 规则切分。"""
        if len(token) < 2:
            return tuple(token)
        word = tuple(token)
        while True:
            pairs = set(zip(word[:-1], word[1:]))
            best, best_rank = None, float("inf")
            for p in pairs:
                r = self.merges.get(p, float("inf"))
                if r < best_rank:
                    best_rank, best = r, p
            if best is None or best_rank == float("inf"):
                break
            a, b = best
            new_word, i = [], 0
            while i < len(word):
                if i < len(word) - 1 and word[i] == a and word[i + 1] == b:
                    new_word.append(a + b)
                    i += 2
                else:
                    new_word.append(word[i])
                    i += 1
            word = tuple(new_word)
            if len(word) == 1:
                break
        return word

    def _encode_ordinary(self, text: str):
        ids = []
        for token in re.findall(self.pattern, text):
            token = "".join(self.byte_encoder[b] for b in token.encode("utf-8"))
            for sym in self._bpe(token):
                ids.append(self.vocab[sym])
        return ids

    def encode(self, text: str, add_special=None):
        ids = []
        if self.special_token_set:
            # 用捕获组 split，保留特殊 token 本身
            special_pat = "(" + "|".join(re.escape(s) for s in self.special_token_set) + ")"
            for part in re.split(special_pat, text):
                if part in self.special_token_set:
                    ids.append(self.special_tokens[part])
                else:
                    ids.extend(self._encode_ordinary(part))
        else:
            ids = self._encode_ordinary(text)
        if add_special is not None:
            ids = [self.special_tokens[add_special]] + ids
        return ids

    def decode(self, ids):
        chars = []
        for i in ids:
            sym = self.id_to_token.get(i)
            if sym is None or sym in self.special_token_set:
                continue
            chars.append(sym)
        text = "".join(chars)
        byte_seq = bytearray(self.byte_decoder[c] for c in text)
        # ignore：模型可能吐出不成完整 UTF-8 的字节，丢弃而非插入乱码占位符
        return byte_seq.decode("utf-8", errors="ignore")

    # ------------------------------------------------------------------
    # 序列化
    # ------------------------------------------------------------------
    def save(self, path: str):
        data = {
            "merges": [list(m) for m in self.merges.keys()],
            "vocab": [[k, v] for k, v in self.vocab.items()],
            "special_tokens": list(self.special_tokens.keys()),
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    @classmethod
    def load(cls, path: str):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        tok = cls()
        tok.special_tokens = {s: i for i, s in enumerate(data["special_tokens"])}
        tok.special_token_set = set(tok.special_tokens.keys())
        tok.merges = {tuple(m): i for i, m in enumerate(data["merges"])}
        tok.vocab = {k: v for k, v in data["vocab"]}
        tok.id_to_token = {v: k for k, v in tok.vocab.items()}
        return tok
