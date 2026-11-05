"""去重：精确（归一化哈希）+ 近似（MinHash / Jaccard）。

近似去重按 sql_template 分桶做局部敏感比较，避免 O(n²) 全量两两比对。
用法： python pipeline/dedup.py [--in data/processed/clean.jsonl]
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.io import read_jsonl, write_json, write_jsonl  # noqa: E402
from common.paths import PROCESSED  # noqa: E402
from common.sqlnorm import minhash_similarity  # noqa: E402


def dedup(rows, threshold=0.88):
    exact, buckets = set(), defaultdict(list)
    kept, removed = [], []

    for r in rows:
        h = r.get('sql_sha1')
        if h in exact:
            removed.append({'id': r['id'], 'reason': 'exact', 'dup_of': h[:12]})
            continue
        exact.add(h)

        sig = tuple(r.get('minhash') or ())
        bucket = r.get('sql_template', 'UNKNOWN')
        near = None
        if sig:
            for prev in buckets[bucket]:
                if minhash_similarity(sig, tuple(prev.get('minhash') or ())) >= threshold:
                    near = prev['id']
                    break
        if near:
            removed.append({'id': r['id'], 'reason': 'near', 'dup_of': near})
            continue

        buckets[bucket].append(r)
        kept.append(r)

    return kept, removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', default=str(PROCESSED / 'clean.jsonl'))
    ap.add_argument('--out', default=str(PROCESSED / 'dedup.jsonl'))
    ap.add_argument('--report', default=str(PROCESSED / 'dedup_report.json'))
    ap.add_argument('--threshold', type=float, default=0.88)
    args = ap.parse_args()

    rows = read_jsonl(args.inp)
    kept, removed = dedup(rows, args.threshold)
    write_jsonl(args.out, kept)
    report = {
        'input': len(rows), 'kept': len(kept), 'removed': len(removed),
        'threshold': args.threshold,
        'exact': sum(1 for x in removed if x['reason'] == 'exact'),
        'near': sum(1 for x in removed if x['reason'] == 'near'),
        'details': removed
    }
    write_json(args.report, report)
    print(f'去重完成：{len(rows)} → {len(kept)} 条'
          f'（精确 {report["exact"]} / 近似 {report["near"]}）')


if __name__ == '__main__':
    main()
