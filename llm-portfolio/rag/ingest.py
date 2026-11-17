"""知识库切分 + 向量化 + 建索引。

backend=auto：装了 sentence-transformers + faiss 就用语义向量 + FAISS，
否则自动降级到**纯 Python 字符 n-gram TF-IDF + numpy 余弦**（零额外依赖，能离线跑通）。

用法：
  python rag/ingest.py
  python rag/ingest.py --backend tfidf     # 强制轻量模式
"""
import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from common.paths import RAG_DOCS, RAG_INDEX  # noqa: E402

DIM = 2048


def split_docs(docs_dir, chunk_size=320, overlap=60):
    """按 markdown 标题层级切块，长段落再按字数滑窗切分。"""
    chunks, headings = [], []
    for f in sorted(Path(docs_dir).glob('*.md')):
        title_path = []
        buf = []
        for line in f.read_text(encoding='utf-8').splitlines() + ['## __EOF__']:
            m = re.match(r'^(#{1,6})\s+(.*)', line)
            if m:
                if buf:
                    chunks.extend(_emit(f, title_path, buf, chunk_size, overlap))
                    buf = []
                level, text = len(m.group(1)), m.group(2).strip()
                title_path = title_path[:level - 1] + [text]
                headings.append(' > '.join(title_path))
                continue
            buf.append(line)
    return chunks


def _emit(file, title_path, lines, size, overlap):
    text = '\n'.join(lines).strip()
    if not text:
        return []
    title = ' > '.join(title_path) or file.stem
    out = []
    i = 0
    while i < len(text):
        part = text[i:i + size]
        out.append({
            'id': f'{file.stem}_{len(out)}_{i}',
            'title': title,
            'source': file.name,
            'text': ('## ' + title + '\n' + part).strip()
        })
        if i + size >= len(text):
            break
        i += size - overlap
    return out


def ngrams(text, n=(2, 3)):
    s = re.sub(r'\s+', '', text.lower())
    grams = []
    for k in n:
        grams += [s[i:i + k] for i in range(len(s) - k + 1)]
    return grams


def _h(g):
    # 稳定哈希，不受 PYTHONHASHSEED 影响
    import hashlib
    return int.from_bytes(hashlib.blake2b(g.encode('utf-8'), digest_size=4).digest(), 'big') % DIM


def tfidf_fit(texts):
    docs = [Counter(_h(g) for g in ngrams(t)) for t in texts]
    df = Counter()
    for d in docs:
        df.update(d.keys())
    n = len(texts)
    idf = np.ones(DIM, dtype=np.float32)
    for j, c in df.items():
        idf[j] = math.log((1 + n) / (1 + c)) + 1.0

    vecs = np.zeros((n, DIM), dtype=np.float32)
    for i, d in enumerate(docs):
        if not d:
            continue
        mx = max(d.values())
        for j, tf in d.items():
            vecs[i, j] = (0.5 + 0.5 * tf / mx) * idf[j]
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    vecs = vecs / np.maximum(norms, 1e-9)
    return vecs, {'idf': idf.tolist(), 'dim': DIM}


def tfidf_query(text, params):
    d = Counter(_h(g) for g in ngrams(text))
    v = np.zeros(params['dim'], dtype=np.float32)
    idf = np.asarray(params['idf'], dtype=np.float32)
    if d:
        mx = max(d.values())
        for j, tf in d.items():
            v[j] = (0.5 + 0.5 * tf / mx) * idf[j]
    return v / max(float(np.linalg.norm(v)), 1e-9)


def semantic_fit(texts, model_name):
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(model_name)
    v = model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
    return np.asarray(v, dtype=np.float32), {'model': model_name}


def save_index(chunks, vecs, backend, params, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'chunks.json').write_text(
        json.dumps(chunks, ensure_ascii=False, indent=2), encoding='utf-8')
    np.save(out / 'vectors.npy', vecs)
    meta = {'backend': backend, 'params': params, 'count': len(chunks),
            'dim': int(vecs.shape[1])}
    (out / 'meta.json').write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--docs', default=str(RAG_DOCS))
    ap.add_argument('--out', default=str(RAG_INDEX))
    ap.add_argument('--backend', choices=['auto', 'tfidf', 'semantic'], default='auto')
    ap.add_argument('--model', default='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    args = ap.parse_args()

    chunks = split_docs(args.docs)
    if not chunks:
        raise SystemExit('没有找到任何 .md 文档，检查 --docs 路径。')
    texts = [c['text'] for c in chunks]

    backend = args.backend
    if backend == 'auto':
        try:
            import sentence_transformers  # noqa: F401
            import faiss  # noqa: F401
            backend = 'semantic'
        except ImportError:
            backend = 'tfidf'
            print('[auto] 未装 sentence-transformers/faiss，降级到纯 Python TF-IDF 检索')

    if backend == 'semantic':
        vecs, params = semantic_fit(texts, args.model)
    else:
        vecs, params = tfidf_fit(texts)

    meta = save_index(chunks, vecs, backend, params, args.out)
    print(f'索引构建完成：{meta["count"]} 个块，backend={backend}，dim={meta["dim"]} → {args.out}')


if __name__ == '__main__':
    main()
