"""向量检索 + 拼装带引用的 Prompt 上下文。

RAG 的判定标准是「检索到的内容被塞进 Prompt 让模型生成答案」，
所以 `build_context()` 生成的是给模型读的上下文，不是给人看的文档列表。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from common.paths import RAG_INDEX  # noqa: E402


class Retriever:
    def __init__(self, index_dir=None):
        self.dir = Path(index_dir or RAG_INDEX)
        meta_path = self.dir / 'meta.json'
        if not meta_path.exists():
            raise FileNotFoundError('索引不存在，请先跑 python rag/ingest.py')
        self.meta = json.loads(meta_path.read_text(encoding='utf-8'))
        self.chunks = json.loads((self.dir / 'chunks.json').read_text(encoding='utf-8'))
        self.vecs = np.load(self.dir / 'vectors.npy')
        self._model = None

    def _query_vec(self, text):
        if self.meta['backend'] == 'semantic':
            if self._model is None:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(self.meta['params']['model'])
            return self._model.encode([text], normalize_embeddings=True)[0].astype(np.float32)
        from rag.ingest import tfidf_query
        return tfidf_query(text, self.meta['params'])

    def retrieve(self, query, k=3):
        q = self._query_vec(query)
        scores = self.vecs @ q
        k = min(k, len(self.chunks))
        idx = np.argsort(-scores)[:k]
        return [{'rank': int(n + 1), 'score': round(float(scores[i]), 4),
                 'title': self.chunks[i]['title'], 'source': self.chunks[i]['source'],
                 'text': self.chunks[i]['text']}
                for n, i in enumerate(idx)]

    def build_context(self, hits):
        parts = []
        for h in hits:
            parts.append(f'[{h["rank"]}] 来源：{h["source"]} / {h["title"]}\n{h["text"]}')
        return '\n\n'.join(parts)


def build_rag_prompt(retriever, question, k=3):
    hits = retriever.retrieve(question, k)
    return {
        'context': retriever.build_context(hits),
        'hits': hits,
        'instruction': ('你是数据仓库指标口径助手。严格依据下面检索到的资料回答问题，'
                        '在答案中用 [1] [2] 标注引用来源；资料没写的内容不要编造。')
    }
