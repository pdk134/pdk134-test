"""清洗：统一 schema → 格式规整 → 可执行性校验 → 质检 → 长度截断。

用法： python pipeline/clean.py [--raw data/raw] [--out data/processed/clean.jsonl]
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.io import read_jsonl, write_json, write_jsonl, write_text  # noqa: E402
from common.paths import PROCESSED, RAW  # noqa: E402
from common.schema import build_input  # noqa: E402
from common.sqlnorm import difficulty, difficulty_level, minhash, sql_hash, sql_template  # noqa: E402
from pipeline.quality_rules import run_quality, report_markdown  # noqa: E402

_WS = re.compile(r'[ \t]+')


def adapt(row, prefix):
    """把 Spider/BIRD 等异构字段统一成内部 schema。"""
    question = row.get('question') or row.get('query_text') or row.get('text') or ''
    sql = row.get('sql') or row.get('query') or row.get('SQL') or ''
    rid = row.get('id') or row.get('question_id') or ''
    return {
        'id': str(rid) or f'{prefix}_{abs(hash(question)) % 10**8:08d}',
        'question': str(question).strip(),
        'sql': str(sql).strip(),
        'db_id': row.get('db_id', 'warehouse'),
        'theme': row.get('theme', '未分类'),
        'source': row.get('source', prefix),
        'license': row.get('license', 'unknown'),
        'tags': row.get('tags', []),
        'context': row.get('context')
    }


def tidy_sql(sql):
    s = sql.strip()
    s = _WS.sub(' ', s.replace('\r\n', '\n'))
    s = re.sub(r'\n{3,}', '\n\n', s)
    s = s.rstrip(';').strip() + ';'
    return s


def tidy_question(q):
    return _WS.sub(' ', q).strip()


def enrich(row):
    row['sql'] = tidy_sql(row['sql'])
    row['question'] = tidy_question(row['question'])
    row['sql_sha1'] = sql_hash(row['sql'])
    row['sql_template'] = sql_template(row['sql'])
    row['difficulty'] = difficulty(row['sql'])
    row['level'] = difficulty_level(row['difficulty'])
    row['minhash'] = list(minhash(row['sql']))
    row['tokens'] = (len(build_input(row['question'])) + len(row['sql'])) // 3
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', default=str(RAW))
    ap.add_argument('--out', default=str(PROCESSED / 'clean.jsonl'))
    ap.add_argument('--report', default=str(PROCESSED / 'quality_report.json'))
    ap.add_argument('--max-tokens', type=int, default=2048)
    args = ap.parse_args()

    raw_dir = Path(args.raw)
    files = sorted(f for f in raw_dir.glob('*.jsonl'))
    rows = []
    for f in files:
        part = [adapt(r, f.stem) for r in read_jsonl(f)]
        rows.extend(part)
        print(f'读取 {f.name}: {len(part)} 条')
    rows = [enrich(r) for r in rows]

    kept, report = run_quality(rows, max_tokens=args.max_tokens)
    kept = [r for r in kept if r['tokens'] <= args.max_tokens]
    report['after_truncation'] = len(kept)

    write_jsonl(args.out, kept)
    write_json(args.report, report)
    write_text(Path(args.report).with_suffix('.md'), report_markdown(report))
    print(f'清洗完成：{len(rows)} → {len(kept)} 条，报告 {args.report}')
    for code, n in sorted(report['by_code'].items()):
        print(f'  {code}: {n}')


if __name__ == '__main__':
    main()
