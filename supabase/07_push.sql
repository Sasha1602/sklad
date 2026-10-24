-- =====================================================================
--  Склад проката — push-уведомления (дополнение к 06_quick.sql)
--  Сначала разверните Edge Function «notify» (см. README), затем:
--  1) замените ВСТАВЬТЕ_… ниже на свои значения (адрес функции и NOTIFY_SECRET);
--  2) Supabase → SQL Editor → New query → вставить → Run.
--  Можно запускать повторно.
-- =====================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Подписки устройств на уведомления (одна строка — один телефон/браузер).
create table if not exists public.push_subs (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists push_subs_own on public.push_subs;
create policy push_subs_own on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.has_role('viewer'));
revoke all on public.push_subs from anon;

-- Куда стучаться: адрес функции и секрет. Видно только владельцу базы.
create table if not exists private.notify_config (
  id     int primary key default 1 check (id = 1),
  url    text not null,
  secret text not null
);
revoke all on private.notify_config from public, anon, authenticated;

insert into private.notify_config (id, url, secret)
values (1, 'https://ВСТАВЬТЕ_ПРОЕКТ.supabase.co/functions/v1/notify', 'ВСТАВЬТЕ_NOTIFY_SECRET')
on conflict (id) do update set url = excluded.url, secret = excluded.secret;

-- Вызов функции. Если адрес ещё не вписан — тихо ничего не делает.
create or replace function private.notify(kind text, target bigint default null)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare c private.notify_config;
begin
  select * into c from private.notify_config where id = 1;
  if c.url is null or c.url like '%ВСТАВЬТЕ%' or c.secret like '%ВСТАВЬТЕ%' then return; end if;
  perform net.http_post(
    url := c.url,
    body := jsonb_build_object('kind', kind, 'id', target),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', c.secret)
  );
exception when others then
  -- уведомление не должно ломать работу склада
  raise warning 'notify(%) не отправлено: %', kind, sqlerrm;
end $$;
revoke all on function private.notify(text, bigint) from public, anon, authenticated;

-- Мероприятие закрыто с недостачей → уведомление менеджерам.
create or replace function private.events_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'returned' and old.status is distinct from 'returned' then
    perform private.notify('event_returned', new.id);
  end if;
  return null;
end $$;
drop trigger if exists events_notify on public.events;
create trigger events_notify after update on public.events
  for each row execute function private.events_notify();

-- Прибор ушёл в ремонт или не найден → уведомление менеджерам.
create or replace function private.items_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (new.state in ('Требует ремонта', 'В ремонте') and new.state is distinct from old.state)
     or (new.status = 'Не найдено' and new.status is distinct from old.status) then
    perform private.notify('item_repair', new.id);
  end if;
  return null;
end $$;
drop trigger if exists items_notify on public.items;
create trigger items_notify after update on public.items
  for each row execute function private.items_notify();

revoke all on function private.events_notify(), private.items_notify() from public, anon, authenticated;

-- Каждый день в 18:00 по Москве (15:00 UTC): завтрашние выезды и просрочки.
select cron.schedule('sklad-daily-notify', '0 15 * * *', $$ select private.notify('daily'); $$);

-- Проверка: отправить тестовое уведомление сотруднику по почте.
--   select private.notify_test('почта@пример.ru');
create or replace function private.notify_test(user_email text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare c private.notify_config; uid uuid;
begin
  select id into uid from public.profiles where lower(email) = lower(user_email);
  if uid is null then return 'Нет пользователя с такой почтой'; end if;
  if not exists (select 1 from public.push_subs where user_id = uid) then return 'У пользователя нет подписки: пусть нажмёт «Включить уведомления» на экране «Сегодня»'; end if;
  select * into c from private.notify_config where id = 1;
  if c.url like '%ВСТАВЬТЕ%' then return 'Сначала впишите адрес функции и секрет в private.notify_config'; end if;
  perform net.http_post(url := c.url, body := jsonb_build_object('kind', 'test', 'user_id', uid),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', c.secret));
  return 'Отправлено — уведомление должно прийти через несколько секунд';
end $$;
revoke all on function private.notify_test(text) from public, anon, authenticated;
