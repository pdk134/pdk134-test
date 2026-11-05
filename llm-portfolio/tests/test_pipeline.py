from common.schema import INSTRUCTION, build_input, make_sft
from pipeline.dedup import dedup
from pipeline.quality_rules import run_quality
from pipeline.sample import stratified


def _row(i, sql, theme='时间口径', level='easy'):
    sql = sql + ';'
    from common.sqlnorm import difficulty, minhash, sql_hash, sql_template
    return {
        'id': f't{i}', 'question': f'测试问题 {i}', 'sql': sql,
        'db_id': 'warehouse', 'theme': theme, 'source': 'seed',
        'license': 'self-authored', 'tags': [],
        'sql_sha1': sql_hash(sql), 'sql_template': sql_template(sql),
        'difficulty': difficulty(sql), 'level': level,
        'minhash': list(minhash(sql)), 'tokens': 100
    }


def test_quality_drops_dml_and_bad_sql():
    good = _row(1, "SELECT SUM(amount) FROM fact_order WHERE dt >= '2024-03-01' AND dt < '2024-04-01'")
    bad = _row(2, 'DELETE FROM fact_order')
    broken = _row(3, 'SELECT * FROM no_such_table')
    kept, report = run_quality([good, bad, broken])
    assert len(kept) == 1 and kept[0]['id'] == 't1'
    assert report['dropped'] == 2


def test_dedup_exact_and_near():
    a = _row(1, "SELECT SUM(amount) FROM fact_order WHERE dt = '2024-03-01'")
    b = _row(2, "SELECT SUM(amount) FROM fact_order WHERE dt = '2024-05-01'")
    c = _row(3, 'SELECT COUNT(DISTINCT user_id) FROM fact_visit')
    kept, removed = dedup([a, b, c], threshold=0.8)
    assert len(kept) < 3, '仅改字面量的样本应被去重'
    assert any(x['reason'] in ('exact', 'near') for x in removed)


def test_stratified_covers_all_buckets():
    rows = [_row(i, "SELECT COUNT(*) FROM dim_user WHERE city = '%s'" % c,
                 theme=c, level=lvl)
            for i, (c, lvl) in enumerate(
                [('时间口径', 'easy'), ('时间口径', 'hard'),
                 ('指标口径', 'easy'), ('指标口径', 'hard')])]
    picked = stratified(rows, target=4)
    assert len(picked) == 4
    assert {r['theme'] for r in picked} == {'时间口径', '指标口径'}


def test_make_sft_schema():
    row = _row(1, 'SELECT COUNT(*) FROM dim_user')
    s = make_sft(row, 'train')
    assert set(s.keys()) == {'instruction', 'input', 'output', 'meta'}
    assert s['instruction'] == INSTRUCTION
    assert '### 问题' in s['input'] and 'CREATE TABLE' in s['input']
    assert s['output'].endswith(';')
    assert s['meta']['split'] == 'train'
    assert build_input('统计订单数').startswith('### 表结构')
