from common.sqlnorm import (difficulty, difficulty_level, minhash,
                            minhash_similarity, normalize_sql, sql_hash,
                            sql_template)


def test_normalize_masks_literals():
    a = "SELECT SUM(amount) FROM fact_order WHERE dt >= '2024-03-01' AND status = 'PAID';"
    b = "select sum(amount) from fact_order where dt >= '2024-04-01' and status='PAID'"
    assert sql_hash(a) == sql_hash(b), '归一化后字面量差异应被抹掉'


def test_normalize_removes_comments():
    s = "-- 注释\nSELECT * FROM dim_user"
    assert '注释' not in normalize_sql(s)


def test_difficulty_features():
    s = ("SELECT u.city, SUM(o.amount) FROM fact_order o "
         "JOIN dim_user u ON o.user_id = u.user_id "
         "WHERE o.status = 'PAID' GROUP BY u.city")
    d = difficulty(s)
    assert d['joins'] == 1
    assert d['aggs'] == 1
    assert d['has_group_by'] == 1
    assert difficulty_level(d) in ('easy', 'medium', 'hard')


def test_template_bucket():
    assert sql_template("SELECT COUNT(*) FROM dim_user") == 'AGG_WHERE'
    assert sql_template("SELECT user_id FROM dim_user WHERE user_id = 1") == 'POINT_LOOKUP'


def test_minhash_similarity():
    a = "SELECT SUM(amount) FROM fact_order WHERE dt = '2024-03-01'"
    b = "SELECT SUM(amount) FROM fact_order WHERE dt = '2024-05-01'"
    c = "SELECT metric_code, definition FROM dim_metric ORDER BY metric_code"
    sim_close = minhash_similarity(minhash(a), minhash(b))
    sim_far = minhash_similarity(minhash(a), minhash(c))
    assert sim_close > sim_far, '结构相同仅字面量不同的 SQL 应更相似'
