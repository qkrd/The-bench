-- Hardware Monitor - Supabase PostgreSQL Schema
-- Supabase SQL Editor에 전체 내용을 붙여넣고 Run 하세요.

create extension if not exists pgcrypto;

-- 1. 사용자 계정 테이블 (데모용)
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  user_id text unique not null,
  name text not null,
  email text not null,
  password_hash text not null,
  created_at timestamptz default now()
);

-- 2. 사용자별 저장된 PC 사양 테이블
create table if not exists public.user_specs (
  id uuid primary key default gen_random_uuid(),
  user_id text unique not null,
  cpu_name text,
  cpu_threads int,
  gpu_name text,
  gpu_vram_gb numeric,
  ram_gb numeric,
  os_name text,
  source_type text,
  updated_at timestamptz default now()
);

-- 3. Row Level Security (RLS) 활성화
alter table public.app_users enable row level security;
alter table public.user_specs enable row level security;

-- 4. 데모용 anon REST 접근 정책 (중복 실행 안전)
drop policy if exists "demo_app_users_select" on public.app_users;
create policy "demo_app_users_select"
  on public.app_users
  for select
  to anon, authenticated
  using (true);

drop policy if exists "demo_app_users_insert" on public.app_users;
create policy "demo_app_users_insert"
  on public.app_users
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "demo_user_specs_select" on public.user_specs;
create policy "demo_user_specs_select"
  on public.user_specs
  for select
  to anon, authenticated
  using (true);

drop policy if exists "demo_user_specs_insert" on public.user_specs;
create policy "demo_user_specs_insert"
  on public.user_specs
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "demo_user_specs_update" on public.user_specs;
create policy "demo_user_specs_update"
  on public.user_specs
  for update
  to anon, authenticated
  using (true)
  with check (true);

-- 5. 기본 데모 공용 계정 (admin / admin) 시드
-- sha256('admin') = 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918
insert into public.app_users (user_id, name, email, password_hash)
values (
  'admin',
  'admin',
  'admin@localhost',
  '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
)
on conflict (user_id) do nothing;
