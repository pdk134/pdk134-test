-- 数据仓库测试库（SQLite）
-- 说明：dt 为分区字段，所有事实表查询必须优先按 dt 做分区裁剪。
-- 口径：GMV = status='PAID' 的 fact_order.amount 之和；取消单/退款单不计入。
--      净支付额 = fact_pay 中 pay_status='SUCCESS' 的 pay_amount 之和。
--      DAU = fact_visit 按 (dt) 去重 user_id 数。

CREATE TABLE dim_date (
  date_key      INTEGER PRIMARY KEY,   -- yyyymmdd
  dt            TEXT NOT NULL,         -- 'YYYY-MM-DD'
  year          INTEGER NOT NULL,
  quarter       INTEGER NOT NULL,
  month         INTEGER NOT NULL,
  day           INTEGER NOT NULL,
  week_of_year  INTEGER NOT NULL,
  is_workday    INTEGER NOT NULL,      -- 1 工作日 / 0 周末
  is_month_end  INTEGER NOT NULL
);

CREATE TABLE dim_user (
  user_id       INTEGER PRIMARY KEY,
  user_name     TEXT NOT NULL,
  city          TEXT NOT NULL,
  channel       TEXT NOT NULL,         -- 渠道：app / web / mini / ads
  register_dt   TEXT NOT NULL,
  vip_level     INTEGER NOT NULL       -- 0-5
);

CREATE TABLE dim_product (
  product_id    INTEGER PRIMARY KEY,
  product_name  TEXT NOT NULL,
  category      TEXT NOT NULL,
  brand         TEXT NOT NULL,
  price         REAL NOT NULL
);

CREATE TABLE fact_order (
  order_id      INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  product_id    INTEGER NOT NULL,
  date_key      INTEGER NOT NULL,
  dt            TEXT NOT NULL,         -- 分区字段
  amount        REAL NOT NULL,
  qty           INTEGER NOT NULL,
  status        TEXT NOT NULL,         -- PAID / CANCELLED / REFUNDED
  created_at    TEXT NOT NULL
);

CREATE TABLE fact_pay (
  pay_id        INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  date_key      INTEGER NOT NULL,
  dt            TEXT NOT NULL,
  pay_amount    REAL NOT NULL,
  pay_status    TEXT NOT NULL,         -- SUCCESS / FAILED
  pay_time      TEXT NOT NULL
);

CREATE TABLE fact_visit (
  visit_id      INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  date_key      INTEGER NOT NULL,
  dt            TEXT NOT NULL,
  page          TEXT NOT NULL,
  duration_sec  INTEGER NOT NULL
);

CREATE TABLE dim_metric (
  metric_code   TEXT PRIMARY KEY,
  metric_name   TEXT NOT NULL,
  definition    TEXT NOT NULL,
  sql_expr      TEXT NOT NULL,
  owner         TEXT NOT NULL
);
