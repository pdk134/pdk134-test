create table if not exists public.task_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  title        text not null,
  note         text not null default '',
  due_date     date not null,
  status       text not null default 'todo',
  priority     smallint not null default 0,
  defer_count  integer not null default 0,
  completed_at timestamptz,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint task_items_status_check check (status in ('todo', 'done')),
  constraint task_items_title_len check (char_length(title) between 1 and 200)
);

comment on table public.task_items is '任务清单：每个任务一行，客户端按 updated_at 做 last-write-wins 同步';

create index if not exists task_items_user_due_idx
  on public.task_items (user_id, due_date);
create index if not exists task_items_user_updated_idx
  on public.task_items (user_id, updated_at);

-- ---------- 行级安全 ----------
alter table public.task_items enable row level security;

drop policy if exists "task_items_select_own" on public.task_items;
create policy "task_items_select_own" on public.task_items
  for select using (auth.uid() = user_id);

drop policy if exists "task_items_insert_own" on public.task_items;
create policy "task_items_insert_own" on public.task_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "task_items_update_own" on public.task_items;
create policy "task_items_update_own" on public.task_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "task_items_delete_own" on public.task_items;
create policy "task_items_delete_own" on public.task_items
  for delete using (auth.uid() = user_id);

-- ---------- 权限 ----------
-- 只授予已登录用户；匿名角色（anon key 未登录）一律无权访问
revoke all on public.task_items from anon;
grant select, insert, update, delete on public.task_items to authenticated;

-- ---------- 自检（执行完可跑一下，应返回 4 行策略）----------
-- select policyname, cmd from pg_policies where tablename = 'task_items';
