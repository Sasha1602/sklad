-- =====================================================================
--  Исправление предупреждений Security Advisor
--  («Public / Signed-In Users Can Execute SECURITY DEFINER Function»).
--  Для базы, где schema.sql уже был запущен. Данные не трогает.
--  Supabase → SQL Editor → New query → вставить → Run
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Переносим функции. Правила доступа и триггеры перейдут за ними сами.
alter function public.my_role()                     set schema private;
alter function public.has_role(public.app_role)     set schema private;
alter function public.handle_new_user()             set schema private;
alter function public.profiles_guard()              set schema private;
alter function public.items_before_write()          set schema private;
alter function public.items_log()                   set schema private;

-- has_role вызывает my_role по имени — обновляем ссылку.
create or replace function private.has_role(min_role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(private.my_role() >= min_role, false) $$;

create or replace function private.items_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if private.my_role() = 'worker' and
       (new.name, new.category, new.place, new.maker, new.model, new.inv, new.serial, new.unit, new.qty_plan, new.price)
       is distinct from
       (old.name, old.category, old.place, old.maker, old.model, old.inv, old.serial, old.unit, old.qty_plan, old.price)
    then
      raise exception 'Кладовщик может менять только количество, состояние, статус и примечание';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- Права на вызов.
revoke all on function private.my_role(), private.has_role(public.app_role) from public, anon;
grant execute on function private.my_role(), private.has_role(public.app_role) to authenticated;
revoke all on function private.handle_new_user(), private.profiles_guard(), private.items_before_write(), private.items_log()
  from public, anon, authenticated;
