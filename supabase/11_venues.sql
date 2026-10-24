-- =====================================================================
--  Склад проката — справочник площадок и залов (дополнение к 02_events.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run.
--  Можно запускать повторно. Площадки из уже созданных мероприятий попадут в справочник сами.
-- =====================================================================

create table if not exists public.venues (
  id         bigint generated always as identity primary key,
  name       text not null unique check (length(trim(name)) > 0),
  address    text,
  contact    text,          -- администратор площадки, телефон
  note       text,          -- въезд, питание, ограничения по звуку…
  created_at timestamptz not null default now()
);

create table if not exists public.venue_halls (
  id       bigint generated always as identity primary key,
  venue_id bigint not null references public.venues(id) on delete cascade,
  name     text not null check (length(trim(name)) > 0),
  note     text,            -- размеры, точки подвеса, розетки…
  unique (venue_id, name)
);

alter table public.events add column if not exists venue_id bigint references public.venues(id) on delete set null;
alter table public.events add column if not exists hall_id  bigint references public.venue_halls(id) on delete set null;

-- Права: видят все сотрудники, меняют менеджер и администратор.
alter table public.venues enable row level security;
alter table public.venue_halls enable row level security;
drop policy if exists venues_select on public.venues;
create policy venues_select on public.venues for select to authenticated using (private.has_role('viewer'));
drop policy if exists venues_write on public.venues;
create policy venues_write on public.venues for all to authenticated using (private.has_role('manager')) with check (private.has_role('manager'));
drop policy if exists venue_halls_select on public.venue_halls;
create policy venue_halls_select on public.venue_halls for select to authenticated using (private.has_role('viewer'));
drop policy if exists venue_halls_write on public.venue_halls;
create policy venue_halls_write on public.venue_halls for all to authenticated using (private.has_role('manager')) with check (private.has_role('manager'));
revoke all on public.venues, public.venue_halls from anon;
grant select, insert, update, delete on public.venues, public.venue_halls to authenticated;

-- Кладовщик по-прежнему не меняет данные мероприятия (теперь и площадку/зал).
create or replace function private.events_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if private.my_role() = 'worker' and
       (new.title, new.venue, new.client, new.date_from, new.date_to, new.responsible, new.note, new.venue_id, new.hall_id)
       is distinct from
       (old.title, old.venue, old.client, old.date_from, old.date_to, old.responsible, old.note, old.venue_id, old.hall_id)
    then
      raise exception 'Кладовщик может только отгружать и принимать возврат';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- Живое обновление на сайте.
do $$ begin alter publication supabase_realtime add table public.venues;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.venue_halls;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- Площадки из уже созданных мероприятий → в справочник.
insert into public.venues (name)
select distinct trim(venue) from public.events
where venue is not null and trim(venue) <> ''
on conflict (name) do nothing;

update public.events e set venue_id = v.id
from public.venues v
where e.venue_id is null and v.name = trim(e.venue);

select count(*) as "площадок в справочнике" from public.venues;
