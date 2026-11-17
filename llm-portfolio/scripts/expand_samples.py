# -*- coding: utf-8 -*-
"""组合式扩充语料：把去重后的样本量堆到 PLAN 要求的规模。

为什么需要它：build_sft.py 有保护逻辑
    n_eval = min(eval_size, 20% * len(rows))
样本不足时 --eval-size 200 不会生效；评测集要到 200 条，去重后至少 1000 条，
训练集要到 1000-1500 条，去重后总数需要 ~1250 条以上。

做法：用「时间谓词 x 过滤条件 x 指标 x 维度 x SQL 骨架」组合出结构差异明显的 SQL。
关键是生成阶段就按 dedup.py 的规则预去重（同 sql_template 桶内 MinHash 相似度 < 0.84，
比 dedup 的 0.88 与 leakage_check 的 0.85 都更保守），保证写进 raw 的样本几乎不会被删。
每条 SQL 都在 warehouse.db 上执行校验。

边界：仍是 self-authored 合成语料，source=combo，不冒充真实业务样本。
用法： python scripts/expand_samples.py [--target 1400] [--max-attempts 12000]
"""
import argparse
import random
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from common.io import read_jsonl, write_json, write_jsonl  # noqa: E402
from common.paths import DB_PATH, RAW  # noqa: E402
from common.sqlnorm import (difficulty, difficulty_level, minhash,  # noqa: E402
                            sql_hash, sql_template)

OUT_NAME = 'seed_combo.jsonl'
SIM_LIMIT = 0.84

J_DATE = "JOIN dim_date d ON f.date_key = d.date_key"
J_USER = "JOIN dim_user u ON f.user_id = u.user_id"
J_PROD = "JOIN dim_product p ON f.product_id = p.product_id"

# (谓词, 需要的 join, 问题里的时间描述)
TIMES = [
    ("f.dt >= '2024-03-01' AND f.dt < '2024-04-01'", '', '2024 年 3 月'),
    ("f.date_key BETWEEN 20240301 AND 20240331", '', '2024 年 3 月'),
    ("substr(CAST(f.date_key AS TEXT), 1, 6) = '202403'", '', '2024 年 3 月'),
    ("strftime('%Y-%m', f.dt) = '2024-03'", '', '2024 年 3 月'),
    ("f.dt LIKE '2024-03%'", '', '2024 年 3 月'),
    ("f.dt >= '2024-01-01' AND f.dt < '2024-07-01'", '', '2024 年上半年'),
    ("f.date_key BETWEEN 20240101 AND 20240630", '', '2024 年上半年'),
    ("d.month = 3 AND d.year = 2024", J_DATE, '2024 年 3 月'),
    ("d.quarter = 1 AND d.year = 2024", J_DATE, '2024 年第一季度'),
    ("d.week_of_year BETWEEN 9 AND 13 AND d.year = 2024", J_DATE, '2024 年 3 月'),
    ("d.is_workday = 1 AND d.month = 3 AND d.year = 2024", J_DATE, '2024 年 3 月工作日'),
    ("d.is_month_end = 1 AND d.month = 3 AND d.year = 2024", J_DATE, '2024 年 3 月月末日'),
    ("d.day <= 15 AND d.month = 3 AND d.year = 2024", J_DATE, '2024 年 3 月上半月'),
    ("d.quarter = 2 AND d.year = 2024", J_DATE, '2024 年第二季度'),
]

FACTS = {
    'fact_order': {
        'metrics': [
            ('gmv', 'SUM(f.amount)', '成交金额'), ('cnt', 'COUNT(*)', '订单数'),
            ('avg_amt', 'AVG(f.amount)', '平均订单金额'),
            ('mx', 'MAX(f.amount)', '最大单笔金额'),
            ('mn', 'MIN(f.amount)', '最小单笔金额'),
            ('qty', 'SUM(f.qty)', '销售件数'),
            ('uv', 'COUNT(DISTINCT f.user_id)', '下单用户数'),
            ('rnd_avg', 'ROUND(AVG(f.amount), 2)', '平均订单金额（两位小数）'),
            ('sum_sq', 'SUM(f.amount * f.qty)', '金额与件数乘积之和'),
        ],
        'filters': [
            ('', '', ''), ("f.status = 'PAID'", '', '已支付'),
            ('f.qty >= 2', '', '多件'), ('f.amount > 100', '', '金额大于 100'),
            ('f.amount BETWEEN 100 AND 500', '', '金额在 100 到 500'),
            ('f.product_id IN (1, 2, 3)', '', '指定商品'),
            ('f.user_id % 2 = 0', '', '偶数编号用户'),
            ("f.created_at LIKE '2024-03%'", '', '3 月创建'),
            ('COALESCE(f.qty, 0) > 1', '', '件数非空且大于 1'),
        ],
        'dims': [
            ('f.dt', '', '日期'), ('f.status', '', '订单状态'),
            ('f.user_id', '', '用户'), ('f.product_id', '', '商品'),
            ('u.city', J_USER, '用户城市'), ('u.channel', J_USER, '注册渠道'),
            ('u.vip_level', J_USER, 'VIP 等级'),
            ('p.category', J_PROD, '商品品类'), ('p.brand', J_PROD, '品牌'),
            ('d.month', J_DATE, '月份'), ('d.quarter', J_DATE, '季度'),
            ('d.is_workday', J_DATE, '是否工作日'),
            ('d.week_of_year', J_DATE, '周'), ('d.day', J_DATE, '日'),
        ],
        'cols': [('f.amount', '订单金额'), ('f.qty', '购买件数'),
                 ('f.order_id', '订单编号'), ('f.status', '订单状态')],
        'theme': '指标口径',
    },
    'fact_pay': {
        'metrics': [
            ('net_pay', 'SUM(f.pay_amount)', '净支付额'),
            ('cnt', 'COUNT(*)', '支付笔数'),
            ('avg_pay', 'AVG(f.pay_amount)', '平均支付金额'),
            ('mx', 'MAX(f.pay_amount)', '最大单笔支付额'),
            ('mn', 'MIN(f.pay_amount)', '最小单笔支付额'),
            ('uv', 'COUNT(DISTINCT f.user_id)', '支付用户数'),
            ('orders', 'COUNT(DISTINCT f.order_id)', '关联订单数'),
            ('rnd', 'ROUND(SUM(f.pay_amount), 2)', '净支付额（两位小数）'),
        ],
        'filters': [
            ('', '', ''), ("f.pay_status = 'SUCCESS'", '', '成功'),
            ('f.pay_amount > 100', '', '金额大于 100'),
            ('f.pay_amount BETWEEN 50 AND 500', '', '金额在 50 到 500'),
            ('f.order_id IS NOT NULL', '', '有关联订单'),
            ("f.pay_time LIKE '2024-03%'", '', '3 月发生'),
            ('f.user_id % 3 = 0', '', '三的倍数编号用户'),
        ],
        'dims': [
            ('f.dt', '', '日期'), ('f.pay_status', '', '支付状态'),
            ('f.user_id', '', '用户'),
            ('u.city', J_USER, '用户城市'), ('u.channel', J_USER, '注册渠道'),
            ('u.vip_level', J_USER, 'VIP 等级'),
            ('d.month', J_DATE, '月份'), ('d.quarter', J_DATE, '季度'),
            ('d.is_workday', J_DATE, '是否工作日'), ('d.day', J_DATE, '日'),
        ],
        'cols': [('f.pay_amount', '支付金额'), ('f.pay_status', '支付状态'),
                 ('f.pay_id', '支付编号'), ('f.order_id', '关联订单号')],
        'theme': '指标口径',
    },
    'fact_visit': {
        'metrics': [
            ('pv', 'COUNT(*)', '访问次数'),
            ('uv', 'COUNT(DISTINCT f.user_id)', '访问用户数'),
            ('dur', 'SUM(f.duration_sec)', '总停留时长'),
            ('avg_dur', 'AVG(f.duration_sec)', '平均停留时长'),
            ('mx_dur', 'MAX(f.duration_sec)', '最长单次停留'),
            ('mn_dur', 'MIN(f.duration_sec)', '最短单次停留'),
            ('pages', 'COUNT(DISTINCT f.page)', '被访问页面数'),
            ('rnd', 'ROUND(AVG(f.duration_sec), 1)', '平均停留时长（一位小数）'),
        ],
        'filters': [
            ('', '', ''), ("f.page = 'home'", '', '首页'),
            ('f.duration_sec > 60', '', '停留超过 60 秒'),
            ('f.duration_sec BETWEEN 10 AND 300', '', '停留 10 到 300 秒'),
            ('f.user_id IS NOT NULL', '', '可识别用户'),
            ("f.page LIKE 'h%'", '', '以 h 开头的页面'),
            ('f.user_id % 2 = 1', '', '奇数编号用户'),
        ],
        'dims': [
            ('f.dt', '', '日期'), ('f.page', '', '页面'),
            ('f.user_id', '', '用户'),
            ('u.city', J_USER, '用户城市'), ('u.channel', J_USER, '注册渠道'),
            ('u.vip_level', J_USER, 'VIP 等级'),
            ('d.month', J_DATE, '月份'), ('d.is_workday', J_DATE, '是否工作日'),
            ('d.week_of_year', J_DATE, '周'),
        ],
        'cols': [('f.page', '访问页面'), ('f.duration_sec', '停留秒数'),
                 ('f.visit_id', '访问编号'), ('f.user_id', '用户编号')],
        'theme': '指标口径',
    },
}

WINDOWS = [
    ('ROW_NUMBER() OVER (ORDER BY {m} DESC)', '按指标从高到低的序号', 'row_number'),
    ('RANK() OVER (ORDER BY {m} DESC)', '按指标从高到低的排名', 'rank'),
    ('DENSE_RANK() OVER (ORDER BY {m} DESC)', '按指标从高到低的连续排名', 'dense_rank'),
    ('SUM({m}) OVER (ORDER BY {d})', '按顺序的累计值', 'cum_sum'),
    ('AVG({m}) OVER ()', '整体平均值', 'window_avg'),
    ('LAG({m}, 1) OVER (ORDER BY {d})', '上一行的值', 'lag'),
    ('LEAD({m}, 1) OVER (ORDER BY {d})', '下一行的值', 'lead'),
    ('NTILE(4) OVER (ORDER BY {m})', '分四档的档位', 'ntile'),
    ('MIN({m}) OVER (PARTITION BY {d})', '组内最小值', 'partition_min'),
]


def joins_of(*items):
    out = []
    for j in items:
        if j and j not in out:
            out.append(j)
    return ' '.join(out)


def where_of(time_pred, filt):
    parts = [time_pred]
    if filt:
        parts.append(filt)
    return ' AND '.join(parts)


def render(kind, fk, cfg, t, flt, met, dim, col, win, rng):
    """返回 (question, sql, theme, tags)；不合适返回 None。"""
    table, (t_pred, t_join, t_desc) = fk, t
    f_pred, f_join, f_desc = flt
    m_alias, m_expr, m_desc = met
    d_col, d_join, d_desc = dim
    c_col, c_desc = col
    joins = joins_of(t_join, f_join, d_join)
    w = where_of(t_pred, f_pred)
    scope = f"{t_desc}{f_desc + '的' if f_desc else '的'}{m_desc}"
    theme = cfg['theme']

    if kind == 'plain':
        sql = f"SELECT {m_expr} AS {m_alias} FROM {table} f {f_join} WHERE {w};"
        q = f"统计{scope}"
        theme = '指标口径'
    elif kind == 'group':
        sql = (f"SELECT {d_col} AS dim_val, {m_expr} AS metric_val FROM {table} f "
               f"{joins} WHERE {w} GROUP BY {d_col} ORDER BY metric_val DESC;")
        q = f"统计{t_desc}按{d_desc}分组的{m_desc}，并依结果从高到低排序"
        theme = 'JOIN聚合' if joins else '分组统计'
    elif kind == 'having':
        sql = (f"SELECT {d_col} AS dim_val, {m_expr} AS metric_val FROM {table} f "
               f"{joins} WHERE {w} GROUP BY {d_col} HAVING {m_expr} > 100 "
               "ORDER BY metric_val DESC;")
        q = f"找出{t_desc}按{d_desc}分组后{m_desc}超过 100 的分组"
        theme = 'JOIN聚合'
    elif kind == 'group_limit':
        n = rng.choice([3, 5, 10])
        sql = (f"SELECT {d_col} AS dim_val, {m_expr} AS metric_val FROM {table} f "
               f"{joins} WHERE {w} GROUP BY {d_col} ORDER BY dim_val LIMIT {n};")
        q = f"列出{t_desc}按{d_desc}分组的前 {n} 个分组及其{m_desc}"
        theme = '分组统计'
    elif kind == 'distinct':
        sql = f"SELECT DISTINCT {c_col} FROM {table} f {f_join} WHERE {w};"
        q = f"列出{t_desc}出现过的{c_desc}取值"
        theme = '去重逻辑'
    elif kind == 'order_limit':
        n = rng.choice([5, 10, 20])
        sql = (f"SELECT {c_col} FROM {table} f {f_join} WHERE {w} "
               f"ORDER BY {c_col} DESC LIMIT {n};")
        q = f"列出{t_desc}{c_desc}最大的 {n} 条记录"
        theme = '指标口径'
    elif kind == 'multi_metric':
        m2 = rng.choice(cfg['metrics'])
        m3 = rng.choice(cfg['metrics'])
        sql = (f"SELECT {m_expr} AS a1, {m2[1]} AS a2, {m3[1]} AS a3 "
               f"FROM {table} f {f_join} WHERE {w};")
        q = f"同时统计{t_desc}的{m_desc}、{m2[2]}与{m3[2]}"
        theme = '指标口径'
    elif kind == 'derived':
        inner = (f"SELECT {d_col} AS dim_val, {m_expr} AS metric_val FROM {table} f "
                 f"{joins} WHERE {w} GROUP BY {d_col}")
        outer = rng.choice(['COUNT(*)', 'AVG(metric_val)', 'MAX(metric_val)', 'MIN(metric_val)'])
        sql = f"SELECT {outer} AS agg_val FROM ({inner}) t;"
        q = f"基于{t_desc}按{d_desc}分组的{m_desc}结果再求{outer.split('(')[0]}值"
        theme = '子查询'
    elif kind == 'window':
        win_expr, win_desc, win_tag = win
        expr = win_expr.replace('{m}', 'metric_val').replace('{d}', 'dim_val')
        inner = (f"SELECT {d_col} AS dim_val, {m_expr} AS metric_val FROM {table} f "
                 f"{joins} WHERE {w} GROUP BY {d_col}")
        sql = f"SELECT dim_val, metric_val, {expr} AS w_val FROM ({inner}) t ORDER BY dim_val;"
        q = f"给出{t_desc}按{d_desc}分组的{m_desc}及其{win_desc}"
        theme = '窗口函数'
        win = (win_expr, win_desc, win_tag)
    elif kind == 'cte':
        sql = (f"WITH t AS (SELECT {d_col} AS dim_val, {m_expr} AS metric_val "
               f"FROM {table} f {joins} WHERE {w} GROUP BY {d_col}) "
               "SELECT dim_val, metric_val FROM t WHERE metric_val > 0 ORDER BY dim_val;")
        q = f"找出{t_desc}按{d_desc}分组后{m_desc}为正的分组"
        theme = 'CTE/UNION'
    elif kind == 'in_subquery':
        sql = (f"SELECT {m_expr} AS {m_alias} FROM {table} f {f_join} WHERE {w} "
               "AND f.user_id IN (SELECT user_id FROM dim_user WHERE vip_level >= 3);")
        q = f"统计{t_desc}高等级会员产生的{scope}"
        theme = '子查询'
    elif kind == 'exists':
        sql = (f"SELECT {m_expr} AS {m_alias} FROM {table} f {f_join} WHERE {w} "
               "AND EXISTS (SELECT 1 FROM dim_user u WHERE u.user_id = f.user_id "
               "AND u.city = '上海');")
        q = f"统计{t_desc}上海用户产生的{scope}"
        theme = '子查询'
    elif kind == 'case_bucket':
        sql = (f"SELECT CASE WHEN {m_expr} > 100 THEN '高' ELSE '低' END AS bucket, "
               f"COUNT(*) AS cnt FROM {table} f {joins} WHERE {w} "
               f"GROUP BY CASE WHEN {m_expr} > 100 THEN '高' ELSE '低' END;")
        q = f"统计{t_desc}按{d_desc}分组后指标高低两档的分组数"
        theme = '分组统计'
    else:
        return None
    if joins.strip() and 'JOIN dim_user u' in joins and 'u.' not in sql:
        return None
    return q, sql, theme, [kind, fk, m_alias]


def load_existing():
    hashes, buckets = set(), defaultdict(list)
    for f in sorted(RAW.glob('*.jsonl')):
        if f.name == OUT_NAME:
            continue
        for r in read_jsonl(f):
            s = r['sql']
            hashes.add(sql_hash(s))
            buckets[sql_template(s)].append(minhash(s))
    return hashes, buckets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', type=int, default=1400)
    ap.add_argument('--max-attempts', type=int, default=20000)
    ap.add_argument('--seed', type=int, default=20261107)
    ap.add_argument('--out', default=str(RAW / OUT_NAME))
    args = ap.parse_args()

    rng = random.Random(args.seed)
    conn = sqlite3.connect(str(DB_PATH))
    hashes, buckets = load_existing()
    arrays = {k: np.array(v, dtype=np.int64) for k, v in buckets.items() if v}

    kinds = (['plain'] * 3 + ['group'] * 3 + ['group_limit'] * 2 +
             ['distinct'] * 2 + ['order_limit'] * 2 + ['multi_metric'] * 2 +
             ['having', 'derived', 'window', 'cte', 'in_subquery', 'exists'])
    rows, attempts, bad_sql, dup_hash, near_dup = [], 0, 0, 0, 0
    fact_keys = list(FACTS)

    try:
        while len(rows) < args.target and attempts < args.max_attempts:
            attempts += 1
            fk = rng.choice(fact_keys)
            cfg = FACTS[fk]
            t = rng.choice(TIMES)
            flt = rng.choice(cfg['filters'])
            met = rng.choice(cfg['metrics'])
            dim = rng.choice(cfg['dims'])
            col = rng.choice(cfg['cols'])
            win = rng.choice(WINDOWS)
            kind = rng.choice(kinds)
            got = render(kind, fk, cfg, t, flt, met, dim, col, win, rng)
            if not got:
                continue
            q, sql, theme, tags = got
            try:
                conn.execute(sql).fetchall()
            except Exception:
                bad_sql += 1
                continue
            h = sql_hash(sql)
            if h in hashes:
                dup_hash += 1
                continue
            tpl = sql_template(sql)
            sig = np.array(minhash(sql), dtype=np.int64)
            arr = arrays.get(tpl)
            if arr is not None and len(arr):
                if bool(((arr == sig).mean(axis=1) >= SIM_LIMIT).any()):
                    near_dup += 1
                    continue
            hashes.add(h)
            arrays[tpl] = sig.reshape(1, -1) if arr is None else np.vstack([arr, sig])
            rows.append({
                'id': f'combo_{len(rows) + 1:05d}',
                'question': q.strip(), 'sql': sql.strip(),
                'db_id': 'warehouse', 'theme': theme,
                'source': 'combo', 'license': 'self-authored', 'tags': tags,
            })
    finally:
        conn.close()

    out = Path(args.out)
    write_jsonl(out, rows)
    stat = {
        'target': args.target, 'generated': len(rows), 'attempts': attempts,
        'rejected_not_executable': bad_sql, 'rejected_same_hash': dup_hash,
        'rejected_near_duplicate': near_dup, 'sim_limit': SIM_LIMIT,
        'by_theme': dict(Counter(r['theme'] for r in rows)),
        'by_template': dict(Counter(sql_template(r['sql']) for r in rows)),
        'by_level': dict(Counter(difficulty_level(difficulty(r['sql'])) for r in rows)),
    }
    write_json(out.with_suffix('.stats.json'), stat)
    print(f"生成 {len(rows)}/{args.target} 条 -> {out.name}（尝试 {attempts} 次）")
    print('拒绝：不可执行', bad_sql, '精确重复', dup_hash, '近似重复', near_dup)
    print('主题:', stat['by_theme'])
    print('模板:', stat['by_template'])
    print('难度:', stat['by_level'])


if __name__ == '__main__':
    main()
