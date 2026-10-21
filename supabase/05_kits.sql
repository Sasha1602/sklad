-- =====================================================================
--  Склад проката — комплекты (кейсы) (дополнение к 04_schedule.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
--  Можно запускать повторно.
-- =====================================================================

-- Комплект — кейс или набор с постоянным содержимым: «Кейс коммутации», «Стойка DJ»…
create table if not exists public.kits (
  id         bigint generated always as identity primary key,
  name       text not null check (length(trim(name)) > 0),
  place      text,                 -- где лежит кейс
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- Что лежит в комплекте и сколько.
create table if not exists public.kit_items (
  id      bigint generated always as identity primary key,
  kit_id  bigint not null references public.kits(id) on delete cascade,
  item_id bigint not null references public.items(id) on delete cascade,
  qty     numeric not null check (qty > 0),
  unique (kit_id, item_id)
);
create index if not exists kit_items_item_idx on public.kit_items (item_id);

create or replace function private.kits_stamp()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then new.created_at := old.created_at; else new.created_at := now(); end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists kits_stamp on public.kits;
create trigger kits_stamp before insert or update on public.kits
  for each row execute function private.kits_stamp();

-- Журнал: комплекты создают / переименовывают / удаляют.
create or replace function private.kits_log()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id) values ('kit', new.id, new.name, 'insert', null, auth.uid());
  elsif tg_op = 'UPDATE' then
    if (new.name, new.place, new.note) is distinct from (old.name, old.place, old.note) then
      insert into public.item_log (kind, item_id, item_name, action, changes, user_id) values ('kit', new.id, new.name, 'update', null, auth.uid());
    end if;
  else
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id) values ('kit', old.id, old.name, 'delete', null, auth.uid());
  end if;
  return null;
end $$;
drop trigger if exists kits_log on public.kits;
create trigger kits_log after insert or update or delete on public.kits
  for each row execute function private.kits_log();

revoke all on function private.kits_stamp(), private.kits_log() from public, anon, authenticated;

-- Права: видят все с доступом, собирают комплекты менеджеры и администраторы.
alter table public.kits      enable row level security;
alter table public.kit_items enable row level security;

drop policy if exists kits_select on public.kits;
create policy kits_select on public.kits for select to authenticated using (private.has_role('viewer'));
drop policy if exists kits_write on public.kits;
create policy kits_write on public.kits for all to authenticated using (private.has_role('manager')) with check (private.has_role('manager'));

drop policy if exists kit_items_select on public.kit_items;
create policy kit_items_select on public.kit_items for select to authenticated using (private.has_role('viewer'));
drop policy if exists kit_items_write on public.kit_items;
create policy kit_items_write on public.kit_items for all to authenticated using (private.has_role('manager')) with check (private.has_role('manager'));

revoke all on public.kits, public.kit_items from anon;

do $$ begin alter publication supabase_realtime add table public.kits;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.kit_items;
exception when duplicate_object then null; end $$;
alter table public.kits      replica identity full;
alter table public.kit_items replica identity full;
