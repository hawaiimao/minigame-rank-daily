-- ============================================================
-- game_profiles: 单款产品的持久化档案(开发商/玩法/标签/备注)
-- 手动执行: Supabase 控制台 -> SQL Editor -> 粘贴运行
-- 幂等:可重复执行
-- ============================================================

-- 1) 主表:产品档案
create table if not exists public.game_profiles (
  game_name      text primary key,          -- 对应 games.name
  developer      text not null default '',
  gameplay_desc  text not null default '',  -- 玩法描述
  tags           text[] not null default '{}',  -- 标签
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 2) 截图表:一产品多图,可排序
create table if not exists public.game_screenshots (
  id          bigint generated always as identity primary key,
  game_name   text not null references public.game_profiles(game_name) on delete cascade,
  url         text not null,               -- 公开访问 URL
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_game_screenshots_game on public.game_screenshots(game_name, sort_order);

-- 3) 自动更新 updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_game_profiles_updated on public.game_profiles;
create trigger trg_game_profiles_updated
  before update on public.game_profiles
  for each row execute function public.set_updated_at();

-- 4) RLS:默认关闭所有写,开启匿名只读(与现有表一致)
alter table public.game_profiles enable row level security;
alter table public.game_screenshots enable row level security;

drop policy if exists "game_profiles_select_anon" on public.game_profiles;
create policy "game_profiles_select_anon"
  on public.game_profiles for select
  to anon, authenticated
  using (true);

drop policy if exists "game_screenshots_select_anon" on public.game_screenshots;
create policy "game_screenshots_select_anon"
  on public.game_screenshots for select
  to anon, authenticated
  using (true);

-- 注意:写操作(insert/update/delete)不开放给 anon。
-- 后端脚本用 service_role(绕过 RLS)执行写入,与现有 ci_sync 一致。

-- ============================================================
-- Storage: 建 bucket game-shots(公开读,写入仅 service_role)
-- 说明:Supabase 的 storage bucket 创建需要走控制台或 SQL。
-- 用以下 SQL 方式创建(新版 Supabase 支持 via storage schema):
-- ============================================================
insert into storage.buckets (id, name, public)
values ('game-shots', 'game-shots', true)
on conflict (id) do nothing;

-- 允许匿名/认证用户读取该 bucket 内对象(前端展示截图用)
drop policy if exists "game-shots-public-read" on storage.objects;
create policy "game-shots-public-read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'game-shots');

-- 上传/删除仅允许 service_role(默认 storage 对 service_role 放行;
-- 若需显式策略可加,但 service_role 本就不受 RLS 限制,通常无需)。

select 'OK: game_profiles + game_screenshots + game-shots bucket 已就绪' as result;
