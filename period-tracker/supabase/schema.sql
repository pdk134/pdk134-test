-- =========================================================
-- 月记（period-tracker）— Supabase 建表脚本
-- 在 Supabase Dashboard → SQL Editor 里整段执行一次即可（dev / prod 两个项目各执行一次）。
--
-- 设计：
--   - 每个用户一行：user_id 主键，整份记录以 JSON 存在 data 列；
--   - RLS 打开，四个策略都限定 auth.uid() = user_id —— 任何人只能读写自己那一行；
--   - anon 角色完全无权访问（未登录读不到任何数据）；
--   - 与学习通的 progress 表互不影响。
-- =========================================================

create table if not exists public.period_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at bigint      not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.period_data is '月记：每个用户一行，整份经期记录以 JSON 保存';

-- ---------- 行级安全 ----------
alter table public.period_data enable row level security;

drop policy if exists "period_data_select_own" on public.period_data;
create policy "period_data_select_own" on public.period_data
  for select using (auth.uid() = user_id);

drop policy if exists "period_data_insert_own" on public.period_data;
create policy "period_data_insert_own" on public.period_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "period_data_update_own" on public.period_data;
create policy "period_data_update_own" on public.period_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "period_data_delete_own" on public.period_data;
create policy "period_data_delete_own" on public.period_data
  for delete using (auth.uid() = user_id);

-- ---------- 权限 ----------
-- 只授予已登录用户；匿名角色（anon key 未登录）一律无权访问
revoke all on public.period_data from anon;
grant select, insert, update, delete on public.period_data to authenticated;

-- ---------- 自检（执行完可跑一下，应返回 4 行策略）----------
-- select policyname, cmd from pg_policies where tablename = 'period_data';
