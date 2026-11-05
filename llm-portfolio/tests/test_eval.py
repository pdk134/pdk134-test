from eval.error_taxonomy import classify, markdown_table, summarize
from eval.run_eval import result_equal


def test_result_equal_unordered():
    gold = [(1, 'a'), (2, 'b')]
    pred = [(2, 'b'), (1, 'a')]
    assert result_equal(gold, pred) is True
    assert result_equal(gold, pred, ordered=True) is False


def test_result_equal_float_tolerance():
    assert result_equal([(0.3000000001,)], [(0.3,)]) is True
    assert result_equal([(1,)], [(2,)]) is False


def test_classify_exec_and_schema():
    code, _ = classify('SELECT 1', 'SELECT FROM', exec_error='near "FROM": syntax error')
    assert code == 'EXEC_ERROR'
    code, _ = classify('SELECT 1', 'SELECT x FROM t', exec_error='no such column: x')
    assert code == 'SCHEMA_ERROR'


def test_classify_dedup_and_time():
    gold = "SELECT COUNT(DISTINCT user_id) FROM fact_visit WHERE dt = '2024-03-01'"
    pred = "SELECT COUNT(user_id) FROM fact_visit WHERE dt = '2024-03-01'"
    assert classify(gold, pred)[0] == 'DEDUP_ERROR'
    gold2 = "SELECT SUM(amount) FROM fact_order WHERE dt >= '2024-03-01' AND dt < '2024-04-01'"
    pred2 = "SELECT SUM(amount) FROM fact_order WHERE dt >= '2024-04-01' AND dt < '2024-05-01'"
    assert classify(gold2, pred2)[0] == 'TIME_SCOPE_ERROR'


def test_summarize_table():
    items = [{'result_match': False, 'error_type': 'EXEC_ERROR'},
             {'result_match': True, 'error_type': 'OK'}]
    stats = summarize(items)
    assert stats['EXEC_ERROR']['count'] == 1
    assert stats['EXEC_ERROR']['ratio'] == 1.0
    assert '| 错误类型' in markdown_table(stats)
