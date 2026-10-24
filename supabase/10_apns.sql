-- =====================================================================
--  Склад проката — push в приложение для iPhone (дополнение к 07_push.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run.
--  Можно запускать повторно.
-- =====================================================================

-- Токены устройств приложения (один iPhone — одна строка).
create table if not exists public.apns_tokens (
  token      text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  env        text not null default 'production' check (env in ('sandbox','production')),
  updated_at timestamptz not null default now()
);
alter table public.apns_tokens enable row level security;
drop policy if exists apns_tokens_own on public.apns_tokens;
create policy apns_tokens_own on public.apns_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.has_role('viewer'));
revoke all on public.apns_tokens from anon;

-- Человека поставили в команду мероприятия → push ему (и в приложение, и на сайт).
create or replace function private.event_crew_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.user_id is not null and new.user_id is distinct from auth.uid()
     and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
    perform private.notify('crew_added', new.id);
  end if;
  return null;
end $$;
drop trigger if exists event_crew_notify on public.event_crew;
create trigger event_crew_notify after insert or update of user_id on public.event_crew
  for each row execute function private.event_crew_notify();
revoke all on function private.event_crew_notify() from public, anon, authenticated;

-- Проверка уведомлений учитывает и приложение для iPhone:
--   select private.notify_test('почта@пример.ru');
create or replace function private.notify_test(user_email text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare c private.notify_config; uid uuid;
begin
  select id into uid from public.profiles where lower(email) = lower(user_email);
  if uid is null then return 'Нет пользователя с такой почтой'; end if;
  if not exists (select 1 from public.push_subs where user_id = uid)
     and not exists (select 1 from public.apns_tokens where user_id = uid) then
    return 'У пользователя нет подписки: пусть включит уведомления на сайте («Сегодня») или в приложении («Ещё» → Push-уведомления)';
  end if;
  select * into c from private.notify_config where id = 1;
  if c.url like '%ВСТАВЬТЕ%' then return 'Сначала впишите адрес функции и секрет в private.notify_config'; end if;
  perform net.http_post(url := c.url, body := jsonb_build_object('kind', 'test', 'user_id', uid),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', c.secret));
  return 'Отправлено — уведомление должно прийти через несколько секунд';
end $$;
revoke all on function private.notify_test(text) from public, anon, authenticated;
