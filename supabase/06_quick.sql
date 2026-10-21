-- =====================================================================
--  Склад проката — быстрый прокат и сборка сканером (дополнение к 05_kits.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
--  Можно запускать повторно.
-- =====================================================================

-- Пометка «быстрый прокат» (сумка с коммутацией и т.п.).
alter table public.events add column if not exists quick boolean not null default false;

-- Кладовщик может создавать мероприятия (быстрый прокат).
drop policy if exists events_insert on public.events;
create policy events_insert on public.events for insert to authenticated with check (private.has_role('worker'));

-- Мероприятие ещё не отгружено?
create or replace function private.event_is_planned(eid bigint)
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.events where id = eid and status = 'planned') $$;
revoke all on function private.event_is_planned(bigint) from public, anon;
grant execute on function private.event_is_planned(bigint) to authenticated;

-- Кладовщик добавляет и убирает оборудование, пока мероприятие не отгружено.
drop policy if exists event_items_insert on public.event_items;
create policy event_items_insert on public.event_items for insert to authenticated
  with check (private.has_role('manager') or (private.has_role('worker') and private.event_is_planned(event_id)));
drop policy if exists event_items_delete on public.event_items;
create policy event_items_delete on public.event_items for delete to authenticated
  using (private.has_role('manager') or (private.has_role('worker') and private.event_is_planned(event_id)));

-- …и меняет «сколько нужно», тоже только до отгрузки.
create or replace function private.event_items_before_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if private.my_role() = 'worker' then
    if (new.event_id, new.item_id) is distinct from (old.event_id, old.item_id) then
      raise exception 'Кладовщик может отмечать только погрузку и возврат';
    end if;
    if new.qty is distinct from old.qty and not private.event_is_planned(old.event_id) then
      raise exception 'После отгрузки список может менять только менеджер';
    end if;
  end if;
  return new;
end $$;
