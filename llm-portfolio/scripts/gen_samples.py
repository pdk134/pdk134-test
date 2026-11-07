# -*- coding: utf-8 -*-
"""确定性生成自写 Text-to-SQL 样本（PLAN W2-W3 数据准备）。

为什么要按「结构」生成：项目用归一化哈希判重复，字面量（日期、数值）会被抹成 ?，
所以光换日期不算新样本。这里让差异来自表名 / 列名 / 聚合函数 / 子句的组合。

每条 SQL 都在 data/warehouse.db 上真实执行校验，不可执行的直接丢弃并留记录。
产物是 self-authored 合成语料，用于撑起分层采样与冻结评测集；
按 PLAN，正式实验前仍需混入用户自己数仓的真实样本。

用法： python scripts/gen_samples.py [--out data/raw/seed_samples_ext.jsonl]
"""
import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from common.io import write_json, write_jsonl  # noqa: E402
from common.paths import DB_PATH, RAW  # noqa: E402
from common.sqlnorm import (difficulty, difficulty_level, sql_hash,  # noqa: E402
                            sql_template)

T = "f.dt >= '2024-03-01' AND f.dt < '2024-04-01'"
JOIN_USER = "JOIN dim_user u ON f.user_id = u.user_id"
JOIN_DATE = "JOIN dim_date d ON f.date_key = d.date_key"
JOIN_PRODUCT = "JOIN dim_product p ON f.product_id = p.product_id"

FACTS = {
    'order': {
        'table': 'fact_order',
        'metrics': [
            ('gmv', 'SUM(f.amount)', '成交金额'),
            ('order_cnt', 'COUNT(*)', '订单数'),
            ('avg_amount', 'AVG(f.amount)', '平均订单金额'),
            ('max_amount', 'MAX(f.amount)', '最大单笔金额'),
            ('total_qty', 'SUM(f.qty)', '销售件数'),
            ('buyers', 'COUNT(DISTINCT f.user_id)', '下单用户数'),
        ],
        'filters': [
            ('', ''),
            ("AND f.status = 'PAID'", '（仅已支付订单）'),
            ('AND f.qty >= 2', '（仅多件订单）'),
            ('AND f.amount > 100', '（仅金额大于 100 的订单）'),
        ],
        'own_dims': [('f.dt', '日期'), ('f.status', '订单状态'), ('f.product_id', '商品')],
    },
    'pay': {
        'table': 'fact_pay',
        'metrics': [
            ('net_pay', 'SUM(f.pay_amount)', '净支付额'),
            ('pay_cnt', 'COUNT(*)', '支付笔数'),
            ('avg_pay', 'AVG(f.pay_amount)', '平均支付金额'),
            ('max_pay', 'MAX(f.pay_amount)', '最大单笔支付额'),
            ('min_pay', 'MIN(f.pay_amount)', '最小单笔支付额'),
            ('pay_users', 'COUNT(DISTINCT f.user_id)', '支付用户数'),
        ],
        'filters': [
            ('', ''),
            ("AND f.pay_status = 'SUCCESS'", '（仅成功支付）'),
            ('AND f.pay_amount > 100', '（仅金额大于 100 的支付）'),
            ('AND f.order_id IS NOT NULL', '（仅有关联订单的支付）'),
        ],
        'own_dims': [('f.dt', '日期'), ('f.pay_status', '支付状态')],
    },
    'visit': {
        'table': 'fact_visit',
        'metrics': [
            ('pv', 'COUNT(*)', '访问次数'),
            ('dau_users', 'COUNT(DISTINCT f.user_id)', '访问用户数'),
            ('total_duration', 'SUM(f.duration_sec)', '总停留时长'),
            ('avg_duration', 'AVG(f.duration_sec)', '平均停留时长'),
            ('max_duration', 'MAX(f.duration_sec)', '最长单次停留'),
            ('page_cnt', 'COUNT(DISTINCT f.page)', '被访问页面数'),
        ],
        'filters': [
            ('', ''),
            ("AND f.page = 'home'", '（仅首页访问）'),
            ('AND f.duration_sec > 60', '（仅停留超过 60 秒的访问）'),
            ('AND f.user_id IS NOT NULL', '（仅能识别用户的访问）'),
        ],
        'own_dims': [('f.dt', '日期'), ('f.page', '页面')],
    },
}

SHARED_DIMS = [
    ('u.city', JOIN_USER, '用户城市'),
    ('u.channel', JOIN_USER, '注册渠道'),
    ('u.vip_level', JOIN_USER, 'VIP 等级'),
    ('d.month', JOIN_DATE, '月份'),
    ('d.quarter', JOIN_DATE, '季度'),
    ('d.is_workday', JOIN_DATE, '是否工作日'),
    ('d.is_month_end', JOIN_DATE, '是否月末'),
]


def gen_single_agg():
    for key, cfg in FACTS.items():
        for alias, expr, label in cfg['metrics']:
            for cond, note in cfg['filters']:
                sql = f"SELECT {expr} AS {alias} FROM {cfg['table']} f WHERE {T} {cond}".strip() + ';'
                yield (f"统计 2024 年 3 月{note}的{label}", sql, '指标口径',
                       [f'fact_{key}', alias])


def gen_groupby():
    for key, cfg in FACTS.items():
        dims = [(col, '', label) for col, label in cfg['own_dims']] + SHARED_DIMS
        if key == 'order':
            dims += [('p.category', JOIN_PRODUCT, '商品品类'),
                     ('p.brand', JOIN_PRODUCT, '品牌')]
        for col, join, label in dims:
            for alias, expr, mlabel in cfg['metrics'][:4]:
                sql = (f"SELECT {col} AS dim_val, {expr} AS metric_val "
                       f"FROM {cfg['table']} f {join} WHERE {T} "
                       f"GROUP BY {col} ORDER BY metric_val DESC;")
                yield (f"统计 2024 年 3 月按{label}分组的{mlabel}，并依结果从高到低排序",
                       sql, 'JOIN聚合' if join else '分组统计', ['group_by', alias])


def gen_multi_join():
    combos = [
        (JOIN_USER + ' ' + JOIN_DATE, [('u.city', '用户城市'), ('d.is_workday', '是否工作日')]),
        (JOIN_USER + ' ' + JOIN_PRODUCT, [('u.channel', '注册渠道'), ('p.category', '商品品类')]),
        (JOIN_PRODUCT + ' ' + JOIN_DATE, [('p.brand', '品牌'), ('d.month', '月份')]),
    ]
    metrics = [('gmv', 'SUM(f.amount)', '成交金额'), ('order_cnt', 'COUNT(*)', '订单数'),
               ('avg_amount', 'AVG(f.amount)', '平均订单金额'),
               ('buyers', 'COUNT(DISTINCT f.user_id)', '下单用户数')]
    for joins, dims in combos:
        for col, label in dims:
            for alias, expr, mlabel in metrics:
                sql = (f"SELECT {col} AS dim_val, {expr} AS metric_val FROM fact_order f "
                       f"{joins} WHERE {T} AND f.status = 'PAID' "
                       f"GROUP BY {col} ORDER BY metric_val DESC;")
                yield (f"统计 2024 年 3 月已支付订单按{label}分组的{mlabel}，并依结果从高到低排序",
                       sql, 'JOIN聚合', ['multi_join', alias])


def gen_subquery():
    items = [
        (f"SELECT COUNT(*) AS cnt FROM fact_order f WHERE {T} "
         "AND f.user_id IN (SELECT user_id FROM dim_user WHERE vip_level >= 3);",
         '统计 2024 年 3 月 VIP3 及以上用户产生的订单数', 'vip'),
        (f"SELECT COUNT(*) AS cnt FROM fact_order f WHERE {T} "
         "AND f.user_id NOT IN (SELECT user_id FROM dim_user WHERE city = '上海');",
         '统计 2024 年 3 月非上海用户产生的订单数', 'city'),
        (f"SELECT COUNT(*) AS cnt FROM fact_order f WHERE {T} "
         "AND EXISTS (SELECT 1 FROM dim_user u WHERE u.user_id = f.user_id AND u.vip_level >= 3);",
         '统计 2024 年 3 月存在高等级会员身份的订单数', 'exists'),
        (f"SELECT SUM(f.amount) AS gmv FROM fact_order f WHERE {T} "
         "AND f.product_id IN (SELECT product_id FROM dim_product WHERE price > 500);",
         '统计 2024 年 3 月高单价商品的成交金额', 'in_product'),
        (f"SELECT AVG(t.day_gmv) AS avg_daily_gmv FROM "
         f"(SELECT f.dt AS dt, SUM(f.amount) AS day_gmv FROM fact_order f WHERE {T} GROUP BY f.dt) t;",
         '统计 2024 年 3 月每日成交金额的平均值', 'derived_table'),
        (f"SELECT COUNT(*) AS cnt FROM fact_pay f WHERE {T} "
         "AND f.order_id IN (SELECT order_id FROM fact_order WHERE dt >= '2024-03-01' AND dt < '2024-04-01');",
         '统计 2024 年 3 月能匹配到当月订单的支付笔数', 'in_order'),
        (f"SELECT SUM(f.pay_amount) AS net_pay FROM fact_pay f WHERE {T} "
         "AND f.pay_status = 'SUCCESS' AND f.user_id IN "
         "(SELECT user_id FROM dim_user WHERE channel = 'app');",
         '统计 2024 年 3 月 App 渠道用户的净支付额', 'in_channel'),
        (f"SELECT MAX(t.pv) AS max_pv FROM "
         f"(SELECT f.dt AS dt, COUNT(*) AS pv FROM fact_visit f WHERE {T} GROUP BY f.dt) t;",
         '统计 2024 年 3 月单日最高访问次数', 'derived_max'),
        (f"SELECT COUNT(*) AS cnt FROM fact_visit f WHERE {T} "
         "AND f.user_id IN (SELECT user_id FROM dim_user WHERE vip_level = 5);",
         '统计 2024 年 3 月 VIP5 用户的访问次数', 'in_vip'),
        (f"SELECT COUNT(*) AS cnt FROM fact_order o WHERE o.dt >= '2024-03-01' "
         "AND o.dt < '2024-04-01' AND o.amount > "
         "(SELECT AVG(amount) FROM fact_order WHERE dt >= '2024-03-01' AND dt < '2024-04-01');",
         '统计 2024 年 3 月金额高于当月平均值的订单数', 'scalar_subquery'),
        (f"SELECT COUNT(*) AS cnt FROM dim_product p WHERE p.product_id NOT IN "
         f"(SELECT f.product_id FROM fact_order f WHERE {T});",
         '统计 2024 年 3 月没有产生订单的商品数', 'not_in'),
        (f"SELECT COUNT(*) AS cnt FROM dim_user u WHERE u.user_id IN "
         f"(SELECT f.user_id FROM fact_pay f WHERE {T} AND f.pay_status = 'SUCCESS');",
         '统计 2024 年 3 月发生过成功支付的用户数', 'in_pay'),
    ]
    for sql, q, tag in items:
        yield q, sql, '子查询', ['subquery', tag]


def gen_window():
    inner = (f"SELECT f.dt AS dt, SUM(f.amount) AS gmv FROM fact_order f "
             f"WHERE {T} GROUP BY f.dt")
    dim_inner = (f"SELECT f.dt AS dt, f.page AS page, COUNT(*) AS pv FROM fact_visit f "
                 f"WHERE {T} GROUP BY f.dt, f.page")
    items = [
        (f"SELECT dt, gmv, ROW_NUMBER() OVER (ORDER BY gmv DESC) AS rn FROM ({inner}) t ORDER BY rn LIMIT 10;",
         '列出 2024 年 3 月成交金额最高的 10 天及其排名', 'row_number'),
        (f"SELECT dt, gmv, RANK() OVER (ORDER BY gmv DESC) AS rk FROM ({inner}) t ORDER BY rk;",
         '给出 2024 年 3 月每日成交金额的排名', 'rank'),
        (f"SELECT dt, gmv, DENSE_RANK() OVER (ORDER BY gmv DESC) AS rk FROM ({inner}) t;",
         '给出 2024 年 3 月每日成交金额的连续排名', 'dense_rank'),
        (f"SELECT dt, gmv, SUM(gmv) OVER (ORDER BY dt) AS cum_gmv FROM ({inner}) t ORDER BY dt;",
         '给出 2024 年 3 月每日成交金额与累计成交金额', 'cum_sum'),
        (f"SELECT dt, gmv, AVG(gmv) OVER () AS avg_gmv FROM ({inner}) t ORDER BY dt;",
         '给出 2024 年 3 月每日成交金额与当月日均成交金额', 'window_avg'),
        (f"SELECT dt, gmv, LAG(gmv, 1) OVER (ORDER BY dt) AS prev_gmv FROM ({inner}) t ORDER BY dt;",
         '给出 2024 年 3 月每日成交金额与前一日成交金额', 'lag'),
        (f"SELECT dt, page, pv, ROW_NUMBER() OVER (PARTITION BY dt ORDER BY pv DESC) AS rn "
         f"FROM ({dim_inner}) t ORDER BY dt, rn;",
         '列出 2024 年 3 月每日各页面的访问次数排名', 'partition_by'),
        (f"SELECT dt, gmv, NTILE(4) OVER (ORDER BY gmv) AS grp FROM ({inner}) t ORDER BY dt;",
         '把 2024 年 3 月每日成交金额分成四档', 'ntile'),
    ]
    for sql, q, tag in items:
        yield q, sql, '窗口函数', ['window', tag]


def gen_advanced():
    items = [
        (f"WITH m AS (SELECT f.dt AS dt, SUM(f.amount) AS gmv FROM fact_order f "
         f"WHERE {T} GROUP BY f.dt) SELECT dt, gmv FROM m WHERE gmv > 1000 ORDER BY gmv DESC;",
         '找出 2024 年 3 月成交金额超过 1000 的日期', 'CTE/UNION', 'cte'),
        ("SELECT '已支付' AS label, COUNT(*) AS cnt FROM fact_order f "
         f"WHERE {T} AND f.status = 'PAID' UNION ALL "
         "SELECT '未支付' AS label, COUNT(*) AS cnt FROM fact_order f "
         f"WHERE {T} AND f.status <> 'PAID';",
         '对比 2024 年 3 月已支付与未支付订单数', 'CTE/UNION', 'union'),
        (f"SELECT CASE WHEN f.amount >= 500 THEN '大额' ELSE '小额' END AS bucket, "
         f"COUNT(*) AS cnt FROM fact_order f WHERE {T} "
         f"GROUP BY CASE WHEN f.amount >= 500 THEN '大额' ELSE '小额' END;",
         '统计 2024 年 3 月大额订单与小额订单的数量', '分组统计', 'case'),
        (f"SELECT u.city AS city, SUM(f.amount) AS gmv FROM fact_order f {JOIN_USER} "
         f"WHERE {T} AND f.status = 'PAID' GROUP BY u.city HAVING SUM(f.amount) > 5000 "
         "ORDER BY gmv DESC;",
         '找出 2024 年 3 月成交金额超过 5000 的城市', 'JOIN聚合', 'having'),
        (f"SELECT f.status AS status, COUNT(*) AS cnt, SUM(f.amount) AS amt "
         f"FROM fact_order f WHERE {T} GROUP BY f.status ORDER BY cnt DESC LIMIT 5;",
         '列出 2024 年 3 月订单量最多的 5 种状态及其金额', '分组统计', 'limit'),
        (f"SELECT COUNT(DISTINCT f.user_id) AS dau FROM fact_visit f {JOIN_DATE} "
         f"WHERE {T} AND d.is_workday = 1;",
         '统计 2024 年 3 月工作日的日均去重访问用户数', '去重逻辑', 'workday_dau'),
        (f"SELECT SUM(f.amount) AS gmv FROM fact_order f {JOIN_DATE} "
         f"WHERE {T} AND d.is_month_end = 1 AND f.status = 'PAID';",
         '统计 2024 年 3 月月末日的已支付成交金额', '时间口径', 'month_end'),
        (f"SELECT d.quarter AS q, SUM(f.pay_amount) AS net_pay FROM fact_pay f {JOIN_DATE} "
         f"WHERE f.dt >= '2024-01-01' AND f.dt < '2024-07-01' AND f.pay_status = 'SUCCESS' "
         "GROUP BY d.quarter ORDER BY q;",
         '统计 2024 年上半年各季度的净支付额', '时间口径', 'quarter'),
    ]
    for sql, q, theme, tag in items:
        yield q, sql, theme, ['advanced', tag]


def gen_easy_and_themes():
    """补齐 easy 档 / POINT_LOOKUP 模板，以及偏稀疏的主题。

    分层抽样按 level x theme x sql_template 分桶，三档难度缺一档就撑不起来。
    这里刻意用「单列点查 + 单条件」，避免 AND 与聚合把难度推到 medium。
    """
    point_cols = {
        'fact_order': [('f.order_id', '订单编号'), ('f.amount', '订单金额'),
                       ('f.user_id', '用户编号'), ('f.status', '订单状态'),
                       ('f.qty', '购买件数'), ('f.created_at', '下单时间')],
        'fact_pay': [('f.pay_id', '支付编号'), ('f.pay_amount', '支付金额'),
                     ('f.pay_status', '支付状态'), ('f.pay_time', '支付时间')],
        'fact_visit': [('f.visit_id', '访问编号'), ('f.page', '访问页面'),
                       ('f.duration_sec', '停留秒数')],
    }
    for table, cols in point_cols.items():
        for col, label in cols:
            yield (f"列出 2024-03-01 的{label}，最多 10 条",
                   f"SELECT {col} FROM {table} f WHERE f.dt = '2024-03-01' LIMIT 10;",
                   '指标口径', ['point_lookup', label])

    for col, label in [('f.status', '订单状态'), ('f.user_id', '用户编号'),
                       ('f.product_id', '商品编号')]:
        yield (f"列出 2024-03-01 出现过的{label}取值",
               f"SELECT DISTINCT {col} FROM fact_order f WHERE f.dt = '2024-03-01';",
               '去重逻辑', ['distinct', label])

    for col, label in [('metric_name', '指标名称'), ('definition', '指标定义'),
                       ('sql_expr', '指标表达式'), ('owner', '指标归属方')]:
        yield (f"列出指标字典里的{label}",
               f"SELECT {col} FROM dim_metric;", '指标口径', ['dim_metric', label])

    for table, label in [('fact_order', '订单'), ('fact_pay', '支付'),
                         ('fact_visit', '访问')]:
        yield (f"统计 2024 年 3 月{label}表按分区键圈定的记录数",
               f"SELECT COUNT(*) AS cnt FROM {table} f "
               "WHERE f.date_key BETWEEN 20240301 AND 20240331;",
               '分区裁剪', ['date_key', label])

    for col, label in [('f.user_id', '下单用户'), ('f.product_id', '商品'),
                       ('f.order_id', '订单')]:
        yield (f"统计 2024 年 3 月去重后的{label}数",
               f"SELECT COUNT(DISTINCT {col}) AS cnt FROM fact_order f WHERE {T};",
               '去重逻辑', ['count_distinct', label])

    for col, label in [('d.week_of_year', '周'), ('d.day', '日'),
                       ('d.year', '年份'), ('d.month', '月份')]:
        yield (f"统计 2024 年 3 月按{label}分组的订单数",
               f"SELECT {col} AS dim_val, COUNT(*) AS cnt FROM fact_order f "
               f"{JOIN_DATE} WHERE {T} GROUP BY {col} ORDER BY dim_val;",
               '时间口径', ['date_dim', label])


def all_templates():
    for fn in (gen_single_agg, gen_groupby, gen_multi_join,
               gen_subquery, gen_window, gen_advanced, gen_easy_and_themes):
        yield from fn()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(RAW / 'seed_samples_ext.jsonl'))
    args = ap.parse_args()

    conn = sqlite3.connect(str(DB_PATH))
    rows, skipped, seen = [], [], set()
    try:
        for q, sql, theme, tags in all_templates():
            try:
                conn.execute(sql).fetchall()
            except Exception as e:
                skipped.append({'question': q, 'error': str(e)[:160]})
                continue
            h = sql_hash(sql)
            if h in seen:
                continue
            seen.add(h)
            rows.append({
                'id': f'ext_{len(rows) + 1:04d}',
                'question': q.strip(),
                'sql': sql.strip(),
                'db_id': 'warehouse',
                'theme': theme,
                'source': 'seed_ext',
                'license': 'self-authored',
                'tags': tags,
            })
    finally:
        conn.close()

    out = Path(args.out)
    write_jsonl(out, rows)
    stat = {
        'generated': len(rows),
        'unique_structures': len(seen),
        'skipped_not_executable': len(skipped),
        'by_theme': dict(Counter(r['theme'] for r in rows)),
        'by_template': dict(Counter(sql_template(r['sql']) for r in rows)),
        'by_level': dict(Counter(difficulty_level(difficulty(r['sql'])) for r in rows)),
        'skipped_examples': skipped[:10],
    }
    write_json(out.with_suffix('.stats.json'), stat)
    print(f"生成 {len(rows)} 条 -> {out.name}（唯一结构 {len(seen)}，不可执行丢弃 {len(skipped)}）")
    print('主题分布:', stat['by_theme'])
    print('模板分布:', stat['by_template'])
    print('难度分布:', stat['by_level'])
    if skipped:
        print('丢弃样例:', stat['skipped_examples'])


if __name__ == '__main__':
    main()
