"""生成 train.jsonl / eval.jsonl，做泄漏校验并**冻结评测集**。

这是 PLAN 里 12/31 的不可挪动节点：
1. 按 (level × theme × sql_template) 分层抽 200 条独立评测集；
2. 与训练集做「精确哈希 + MinHash 近似」双重去重校验；
3. 写 eval.jsonl.sha256 冻结；校验和存在时拒绝覆盖（--force 才允许）。

用法： python pipeline/build_sft.py --eval-size 200
"""
import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.io import (read_jsonl, sha256_file, write_json, write_jsonl)  # noqa: E402
from common.paths import EVAL_HASH, EVAL_JSONL, PROCESSED, TRAIN_JSONL  # noqa: E402
from common.schema import make_sft  # noqa: E402
from common.sqlnorm import minhash_similarity  # noqa: E402


def stratified_split(rows, eval_size):
    buckets = defaultdict(list)
    for r in rows:
        buckets[(r.get('level', 'easy'), r.get('theme', '未分类'),
                 r.get('sql_template', 'POINT_LOOKUP'))].append(r)
    keys = sorted(buckets)
    ev, tr = [], []
    # 轮转：每个桶先各抽 1 条给评测集，保证覆盖度，剩余进训练集
    i = 0
    while True:
        if len(ev) >= eval_size:
            break
        took = False
        for k in keys:
            if i < len(buckets[k]):
                ev.append(buckets[k][i])
                took = True
                if len(ev) >= eval_size:
                    break
        if not took:
            break
        i += 1
    ev_ids = {r['id'] for r in ev}
    tr = [r for r in rows if r['id'] not in ev_ids]
    return tr, ev


def leakage_check(train, ev, threshold=0.85):
    """精确重复直接判定泄漏；近似重复从训练集移除，保证评测独立。"""
    exact = {r['sql_sha1'] for r in ev}
    ev_sigs = [(r['id'], tuple(r.get('minhash') or ())) for r in ev]
    clean, findings = [], []
    for r in train:
        if r['sql_sha1'] in exact:
            findings.append({'id': r['id'], 'type': 'exact', 'eval_id': '', 'sim': 1.0})
            continue
        sig = tuple(r.get('minhash') or ())
        near = None
        for eid, esig in ev_sigs:
            if sig and esig and minhash_similarity(sig, esig) >= threshold:
                near = (eid, minhash_similarity(sig, esig))
                break
        if near:
            findings.append({'id': r['id'], 'type': 'near',
                             'eval_id': near[0], 'sim': round(near[1], 4)})
            continue
        clean.append(r)
    return clean, findings


def load_tokenizer(name):
    if not name:
        return None
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(name, trust_remote_code=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', default=str(PROCESSED / 'sample.jsonl'))
    ap.add_argument('--eval-size', type=int, default=200)
    ap.add_argument('--near-threshold', type=float, default=0.85)
    ap.add_argument('--tokenizer', default=None, help='HF tokenizer 名/路径，用于精确 token 统计')
    ap.add_argument('--force', action='store_true', help='强制重建已冻结的评测集（谨慎）')
    args = ap.parse_args()

    if EVAL_JSONL.exists() and EVAL_HASH.exists() and not args.force:
        recorded = EVAL_HASH.read_text(encoding='utf-8').strip().split()[0]
        actual = sha256_file(EVAL_JSONL)
        if recorded != actual:
            raise SystemExit('评测集校验和不匹配，文件可能被改动；请人工核查后再操作。')
        raise SystemExit(
            '评测集已冻结，拒绝重建（PLAN 12/31 节点）。'
            '确需重建请加 --force，并注意此前所有对比数字作废。'
        )

    rows = read_jsonl(args.inp)
    if not rows:
        raise SystemExit('没有输入样本，请先跑 clean → dedup → sample。')

    n_eval = min(args.eval_size, max(1, int(len(rows) * 0.2)))
    if n_eval < args.eval_size:
        print(f'[提示] 样本量不足，评测集按 20% 取 {n_eval} 条'
              f'（PLAN 要求 200 条，需补充公开数据集后重建）')

    train_raw, eval_raw = stratified_split(rows, n_eval)
    train_raw, findings = leakage_check(train_raw, eval_raw, args.near_threshold)

    tok = load_tokenizer(args.tokenizer)
    train = [make_sft(r, 'train', tok) for r in train_raw]
    ev = [make_sft(r, 'eval', tok) for r in eval_raw]

    write_jsonl(TRAIN_JSONL, train)
    write_jsonl(EVAL_JSONL, ev)
    digest = sha256_file(EVAL_JSONL)
    EVAL_HASH.write_text(digest + '  eval.jsonl\n', encoding='utf-8')
    write_json(PROCESSED / 'leakage_report.json', {
        'eval_size': len(ev), 'train_size': len(train),
        'near_threshold': args.near_threshold,
        'leak_removed': len(findings), 'findings': findings,
        'eval_sha256': digest,
        'frozen': True
    })

    print(f'训练集 {len(train)} 条 → {TRAIN_JSONL.name}')
    print(f'评测集 {len(ev)} 条 → {EVAL_JSONL.name}（已冻结 sha256={digest[:12]}…）')
    print(f'泄漏校验：移除 {len(findings)} 条'
          f'（精确 {sum(1 for f in findings if f["type"] == "exact")} / '
          f'近似 {sum(1 for f in findings if f["type"] == "near")}）')


if __name__ == '__main__':
    main()
