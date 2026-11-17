"""难度分层 + 多样性均衡采样，生成候选训练池。

按 (level × theme × sql_template) 分桶做轮转抽样，避免简单样本淹没难样本。
产出 data/processed/sample.jsonl 与分布统计（JSON + 文本柱状图，不依赖 matplotlib）。

用法： python pipeline/sample.py --target 1200
"""
import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.io import read_jsonl, write_json, write_jsonl, write_text  # noqa: E402
from common.paths import PROCESSED  # noqa: E402


def stratified(rows, target):
    buckets = defaultdict(list)
    for r in rows:
        key = (r.get('level', 'easy'), r.get('theme', '未分类'),
               r.get('sql_template', 'POINT_LOOKUP'))
        buckets[key].append(r)
    # 桶内按难度分降序，优先保留信息量大的样本
    for k in buckets:
        buckets[k].sort(key=lambda x: (
            x.get('difficulty', {}).get('joins', 0) * 2
            + x.get('difficulty', {}).get('has_subquery', 0) * 2
            + x.get('difficulty', {}).get('has_window', 0) * 2), reverse=True)

    keys = sorted(buckets)
    picked = []
    i = 0
    while len(picked) < target and keys:
        active = False
        for k in keys:
            if i < len(buckets[k]):
                picked.append(buckets[k][i])
                active = True
                if len(picked) >= target:
                    break
        if not active:
            break
        i += 1
    return picked


def distribution(rows):
    out = {}
    for field in ('level', 'theme', 'sql_template'):
        out[field] = dict(Counter(r.get(field, '未分类') for r in rows))
    return out


def bar_chart(counter, width=40):
    if not counter:
        return '(空)'
    mx = max(counter.values())
    lines = []
    for k, v in sorted(counter.items(), key=lambda x: -x[1]):
        n = max(1, int(v / mx * width))
        lines.append(f'{str(k):<18} {"#" * n} {v}')
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', default=str(PROCESSED / 'dedup.jsonl'))
    ap.add_argument('--out', default=str(PROCESSED / 'sample.jsonl'))
    ap.add_argument('--stats', default=str(PROCESSED / 'distribution.json'))
    ap.add_argument('--target', type=int, default=1200)
    args = ap.parse_args()

    rows = read_jsonl(args.inp)
    picked = stratified(rows, args.target)
    write_jsonl(args.out, picked)
    dist = distribution(picked)
    write_json(args.stats, {'target': args.target, 'actual': len(picked), 'distribution': dist})
    md = ['# 训练集分布统计', '', f'目标 {args.target} 条，实际 {len(picked)} 条', '']
    for field, counter in dist.items():
        md += [f'## {field}', '', '```', bar_chart(counter), '```', '']
    write_text(Path(args.stats).with_suffix('.md'), '\n'.join(md))
    print(f'采样完成：{len(rows)} → {len(picked)} 条，分布统计 {args.stats}')
    for field, counter in dist.items():
        print(f'  {field}: {len(counter)} 个桶')


if __name__ == '__main__':
    main()
