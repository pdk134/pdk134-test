"""构建 SQLite 数仓测试库（确定性种子，可重复复现评测）。

用法： python scripts/init_db.py [--db data/warehouse.db]
"""
import argparse
import random
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.paths import DB_PATH, SCHEMA_SQL  # noqa: E402

RNG = random.Random(20261104)
START = date(2024, 1, 1)
DAYS = 182  # 2024-01-01 ~ 2024-06-30

CITIES = ['上海', '北京', '深圳', '杭州', '广州', '成都']
CHANNELS = ['app', 'web', 'mini', 'ads']
CATEGORIES = ['数码', '家居', '服饰', '美妆', '食品']
BRANDS = ['A', 'B', 'C', 'D']
PAGES = ['home', 'detail', 'cart', 'pay', 'profile']
STATUSES = ['PAID'] * 8 + ['CANCELLED'] + ['REFUNDED']


def build(conn):
    cur = conn.cursor()
    cur.executescript(SCHEMA_SQL.read_text(encoding='utf-8'))

    dates = []
    for i in range(DAYS):
        d = START + timedelta(days=i)
        dates.append((
            int(d.strftime('%Y%m%d')), d.isoformat(), d.year,
            (d.month - 1) // 3 + 1, d.month, d.day,
            int(d.strftime('%W')), 1 if d.weekday() < 5 else 0,
            1 if (d + timedelta(days=1)).month != d.month else 0
        ))
    cur.executemany('INSERT INTO dim_date VALUES (?,?,?,?,?,?,?,?,?)', dates)

    users = []
    for uid in range(1, 201):
        rd = START + timedelta(days=RNG.randint(0, DAYS - 1))
        users.append((uid, f'user_{uid:03d}', RNG.choice(CITIES),
                      RNG.choice(CHANNELS), rd.isoformat(), RNG.randint(0, 5)))
    cur.executemany('INSERT INTO dim_user VALUES (?,?,?,?,?,?)', users)

    products = []
    for pid in range(1, 41):
        products.append((pid, f'product_{pid:03d}', CATEGORIES[(pid - 1) % len(CATEGORIES)],
                         BRANDS[(pid - 1) % len(BRANDS)], round(RNG.uniform(20, 900), 2)))
    cur.executemany('INSERT INTO dim_product VALUES (?,?,?,?,?)', products)

    orders, pays, visits = [], [], []
    oid = 1
    for i, drow in enumerate(dates):
        dk, dt = drow[0], drow[1]
        # 订单量随月份小幅增长，便于环比/趋势类 SQL 有非零结果
        n_orders = 12 + (drow[4] * 3) + RNG.randint(0, 6)
        for _ in range(n_orders):
            uid = RNG.randint(1, 200)
            pid = RNG.randint(1, 40)
            amount = round(products[pid - 1][4] * RNG.randint(1, 3), 2)
            status = RNG.choice(STATUSES)
            orders.append((oid, uid, pid, dk, dt, amount, RNG.randint(1, 4),
                           status, dt + ' ' + f'{RNG.randint(0,23):02d}:{RNG.randint(0,59):02d}:00'))
            # 大部分有效订单有成功支付；少量重复支付流水用于验证去重逻辑
            if status == 'PAID':
                pays.append((len(pays) + 1, oid, uid, dk, dt, amount, 'SUCCESS', dt + ' 12:00:00'))
                if RNG.random() < 0.08:
                    pays.append((len(pays) + 1, oid, uid, dk, dt, amount, 'SUCCESS', dt + ' 12:05:00'))
            elif RNG.random() < 0.3:
                pays.append((len(pays) + 1, oid, uid, dk, dt, amount, 'FAILED', dt + ' 12:00:00'))
            oid += 1
        for _ in range(30 + RNG.randint(0, 20)):
            uid = RNG.randint(1, 200)
            visits.append((len(visits) + 1, uid, dk, dt, RNG.choice(PAGES), RNG.randint(5, 900)))
            if RNG.random() < 0.12:  # 同用户同日同页面的重复埋点
                visits.append((len(visits) + 1, uid, dk, dt, PAGES[-1], RNG.randint(5, 900)))

    cur.executemany('INSERT INTO fact_order VALUES (?,?,?,?,?,?,?,?,?)', orders)
    cur.executemany('INSERT INTO fact_pay VALUES (?,?,?,?,?,?,?,?)', pays)
    cur.executemany('INSERT INTO fact_visit VALUES (?,?,?,?,?,?)', visits)
    cur.executemany('INSERT INTO dim_metric VALUES (?,?,?,?,?)', [
        ('gmv', '成交总额', "有效订单金额之和，status='PAID'，排除取消单与退款单", "SUM(amount) WHERE status='PAID'", '数据平台'),
        ('dau', '日活跃用户数', '按 dt 分区裁剪后对 user_id 去重计数', 'COUNT(DISTINCT user_id)', '数据平台'),
        ('aov', '客单价', 'GMV 除以有效订单数', 'SUM(amount)/COUNT(DISTINCT order_id)', '数据平台'),
        ('net_pay', '净支付额', "支付流水中 pay_status='SUCCESS' 的 pay_amount 之和", "SUM(pay_amount) WHERE pay_status='SUCCESS'", '支付团队'),
        ('repurchase_rate', '复购率', '有效订单数 >= 2 的用户占全部下单用户比例', '见 seed_047', '增长团队'),
        ('refund_rate', '退款率', '退款订单数 / 全部订单数', '见 seed_043', '风控团队'),
    ])
    conn.commit()
    return {'dates': len(dates), 'users': len(users), 'products': len(products),
            'orders': len(orders), 'pays': len(pays), 'visits': len(visits)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=str(DB_PATH))
    args = ap.parse_args()
    path = Path(args.db)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(str(path))
    try:
        counts = build(conn)
    finally:
        conn.close()
    print('已构建', path)
    for k, v in counts.items():
        print(f'  {k:10s} {v}')


if __name__ == '__main__':
    main()
