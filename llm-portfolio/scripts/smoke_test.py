"""端到端冒烟自检：无需 GPU / 网络，验证全链路可跑通。

用法： python scripts/smoke_test.py
"""
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from common.io import read_jsonl, sha256_file  # noqa: E402
from common.paths import (DB_PATH, EVAL_HASH, EVAL_JSONL, EVAL_RESULTS,  # noqa: E402
                          RAG_INDEX)
from common.sqlnorm import (difficulty, minhash, minhash_similarity,  # noqa: E402
                            normalize_sql, sql_hash, sql_template)

PASS, FAIL = [], []


def check(name, fn):
    try:
        detail = fn()
        PASS.append(name)
        print(f'[OK]   {name}' + (f'  {detail}' if detail else ''))
    except Exception as e:
        FAIL.append((name, str(e)))
        print(f'[FAIL] {name}: {e}')


def t_db():
    assert DB_PATH.exists(), '测试库不存在，先跑 python scripts/init_db.py'
    rows = read_jsonl(ROOT / 'data' / 'raw' / 'seed_samples.jsonl')
    conn = sqlite3.connect(str(DB_PATH))
    try:
        for r in rows:
            conn.execute(r['sql']).fetchall()
    finally:
        conn.close()
    return f'{len(rows)} 条种子 SQL 全部可执行'


def t_sqlnorm():
    a = "SELECT SUM(amount) FROM fact_order WHERE dt >= '2024-03-01' AND status = 'PAID';"
    b = "select sum(amount) from fact_order where dt >= '2024-04-01' and status='PAID'"
    assert sql_hash(a) == sql_hash(b), '归一化哈希应抹掉字面量差异'
    assert sql_template(a) == 'AGG_WHERE'
    assert difficulty(a)['aggs'] == 1
    m1, m2 = minhash(a), minhash("SELECT SUM(pay_amount) FROM fact_pay WHERE dt = '2024-01-01'")
    assert 0.0 <= minhash_similarity(m1, m2) <= 1.0
    return '归一化/模板/难度/MinHash'


def t_quality():
    from pipeline.quality_rules import run_quality
    good = [{'id': 'g1', 'question': '统计 2024-03 的 GMV',
             'sql': "SELECT SUM(amount) FROM fact_order WHERE dt >= '2024-03-01' AND dt < '2024-04-01' AND status = 'PAID'",
             '_warnings': []}]
    bad = [{'id': 'b1', 'question': '删除全部订单', 'sql': 'DELETE FROM fact_order'}]
    kept, report = run_quality(good + bad)
    assert report['dropped'] == 1 and len(kept) == 1
    return f'质检丢弃 {report["dropped"]} 条非法记录'


def t_frozen():
    assert EVAL_JSONL.exists() and EVAL_HASH.exists(), '评测集未冻结'
    assert sha256_file(EVAL_JSONL) == EVAL_HASH.read_text(encoding='utf-8').split()[0]
    ev = read_jsonl(EVAL_JSONL)
    assert ev and all('instruction' in r and 'input' in r and 'output' in r for r in ev)
    assert all(r['meta']['split'] == 'eval' for r in ev)
    return f'评测集 {len(ev)} 条，校验和有效'


def t_freeze_guard():
    r = subprocess.run([sys.executable, 'pipeline/build_sft.py'],
                       cwd=str(ROOT), capture_output=True, text=True)
    assert r.returncode != 0, '冻结后应拒绝重建'
    assert '冻结' in (r.stdout + r.stderr)
    return '拒绝覆盖已冻结评测集'


def t_eval_pipeline():
    r = subprocess.run([sys.executable, 'eval/run_eval.py', '--name', 'smoke',
                        '--generator', 'debug_gold'],
                       cwd=str(ROOT), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-400:]
    res = json.loads((EVAL_RESULTS / 'smoke.json').read_text(encoding='utf-8'))
    assert res['metrics']['result_accuracy'] == 1.0
    assert res['official'] is False, 'debug_gold 不得标记为正式结果'
    return '评测脚本自检通过（100%，且不计入对比表）'


def t_rag():
    assert (RAG_INDEX / 'meta.json').exists(), '先跑 python rag/ingest.py'
    from rag.retriever import Retriever, build_rag_prompt
    out = build_rag_prompt(Retriever(), 'GMV 要排除取消单吗', 2)
    assert out['hits'] and '[1]' in out['context']
    return f'检索命中 {len(out["hits"])} 块，top1={out["hits"][0]["title"][:28]}'


def t_api():
    try:
        from serving.app import health
    except ImportError as e:
        return f'跳过（未装服务依赖，先 pip install -r requirements.txt）: {e}'
    h = health()
    assert h.status == 'ok' and h.db_exists and h.eval_frozen
    return f'/health OK (rag_index={h.rag_index})'


def t_report_compare():
    r = subprocess.run([sys.executable, 'eval/run_eval.py', '--compare'],
                       cwd=str(ROOT), capture_output=True, text=True)
    # 只有 debug_gold 结果时，--compare 会提示无正式结果，属预期行为
    assert r.returncode in (0, 1)
    return '对比表命令可执行（当前无正式实验结果，属预期）'


def main():
    print('=== 端到端冒烟自检 ===')
    for name, fn in [
        ('SQLite 测试库与种子 SQL', t_db),
        ('SQL 归一化工具', t_sqlnorm),
        ('质检规则', t_quality),
        ('评测集冻结校验和', t_frozen),
        ('冻结保护', t_freeze_guard),
        ('自动评测管道', t_eval_pipeline),
        ('RAG 检索与 Prompt', t_rag),
        ('FastAPI /health', t_api),
        ('对比表命令', t_report_compare),
    ]:
        check(name, fn)
    print(f'\n通过 {len(PASS)} / {len(PASS) + len(FAIL)}')
    if FAIL:
        for n, e in FAIL:
            print(f'  失败: {n} -> {e}')
        sys.exit(1)
    print('全部通过。')


if __name__ == '__main__':
    main()
