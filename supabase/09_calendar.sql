-- =====================================================================
--  Склад проката — календарь телефона по ссылке (дополнение к 07_push.sql)
--  Нужна развёрнутая функция уведомлений (она же отдаёт календарь).
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run.
--  Можно запускать повторно.
-- =====================================================================

-- Личная ссылка на календарь: у каждого сотрудника свой секретный токен.
create table if not exists public.cal_tokens (
  user_id    uuid primary key references public.profiles(id) on delete cascade default auth.uid(),
  token      text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);
alter table public.cal_tokens enable row level security;
drop policy if exists cal_tokens_own on public.cal_tokens;
create policy cal_tokens_own on public.cal_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.has_role('viewer'));
revoke all on public.cal_tokens from anon;

-- Адрес функции для сайта (он не секретный; секрет NOTIFY_SECRET сюда не попадает).
create table if not exists public.app_links (
  id      int primary key default 1 check (id = 1),
  cal_url text
);
alter table public.app_links enable row level security;
drop policy if exists app_links_read on public.app_links;
create policy app_links_read on public.app_links for select to authenticated using (private.has_role('viewer'));
revoke all on public.app_links from anon;
grant select on public.app_links to authenticated;

insert into public.app_links (id, cal_url)
select 1, url from private.notify_config where id = 1
on conflict (id) do update set cal_url = excluded.cal_url;

-- Проверка: должен показаться адрес вашей функции.
select cal_url from public.app_links;
