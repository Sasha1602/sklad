-- =====================================================================
--  Склад проката — мероприятия и календарь (дополнение к schema.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
--  Можно запускать повторно — ничего не сломается и не задвоится.
-- =====================================================================

-- ---------- Подготовка: служебная схема private ----------
-- Если fix_security.sql ещё не запускался, этот блок сделает то же самое сам.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

do $$ begin
  if to_regprocedure('private.my_role()') is null and to_regprocedure('public.my_role()') is not null then
    alter function public.my_role() set schema private; end if;
  if to_regprocedure('private.has_role(public.app_role)') is null and to_regprocedure('public.has_role(public.app_role)') is not null then
    alter function public.has_role(public.app_role) set schema private; end if;
  if to_regprocedure('private.handle_new_user()') is null and to_regprocedure('public.handle_new_user()') is not null then
    alter function public.handle_new_user() set schema private; end if;
  if to_regprocedure('private.profiles_guard()') is null and to_regprocedure('public.profiles_guard()') is not null then
    alter function public.profiles_guard() set schema private; end if;
  if to_regprocedure('private.items_before_write()') is null and to_regprocedure('public.items_before_write()') is not null then
    alter function public.items_before_write() set schema private; end if;
  if to_regprocedure('private.items_log()') is null and to_regprocedure('public.items_log()') is not null then
    alter function public.items_log() set schema private; end if;
end $$;

create or replace function private.my_role()
returns public.app_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function private.has_role(min_role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(private.my_role() >= min_role, false) $$;

-- Склад: кладовщик меняет только количество, состояние, статус, примечание.
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

revoke all on function private.my_role(), private.has_role(public.app_role) from public, anon;
grant execute on function private.my_role(), private.has_role(public.app_role) to authenticated;
do $$ begin
  revoke all on function private.handle_new_user(), private.profiles_guard(), private.items_before_write(), private.items_log()
    from public, anon, authenticated;
exception when undefined_function then null; end $$;

-- ---------- Мероприятия ----------
--  status: planned  — запланировано (оборудование забронировано)
--          out      — на выезде (отгружено)
--          returned — завершено (возврат принят)
--          cancelled — отменено (бронь снята)
create table if not exists public.events (
  id          bigint generated always as identity primary key,
  title       text not null check (length(trim(title)) > 0),
  venue       text,
  client      text,
  date_from   date not null,
  date_to     date not null,
  responsible uuid references public.profiles(id) on delete set null,
  status      text not null default 'planned' check (status in ('planned','out','returned','cancelled')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  check (date_to >= date_from)
);
create index if not exists events_dates_idx on public.events (date_from, date_to);

-- ---------- Оборудование в мероприятии ----------
--  qty      — сколько нужно (бронь)
--  qty_out  — сколько реально погрузили
--  qty_back — сколько вернулось
create table if not exists public.event_items (
  id        bigint generated always as identity primary key,
  event_id  bigint not null references public.events(id) on delete cascade,
  item_id   bigint not null references public.items(id) on delete cascade,
  qty       numeric not null check (qty > 0),
  qty_out   numeric check (qty_out is null or qty_out >= 0),
  qty_back  numeric check (qty_back is null or qty_back >= 0),
  note      text,
  unique (event_id, item_id)
);
create index if not exists event_items_item_idx on public.event_items (item_id);

-- Журнал теперь пишет и про мероприятия.
alter table public.item_log add column if not exists kind text not null default 'item';

-- ---------- Триггеры ----------
-- Кладовщик в мероприятии может только менять статус (отгрузка / возврат).
create or replace function private.events_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if private.my_role() = 'worker' and
       (new.title, new.venue, new.client, new.date_from, new.date_to, new.responsible, new.note)
       is distinct from
       (old.title, old.venue, old.client, old.date_from, old.date_to, old.responsible, old.note)
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

drop trigger if exists events_before_write on public.events;
create trigger events_before_write
  before insert or update on public.events
  for each row execute function private.events_before_write();

-- Кладовщик в списке оборудования отмечает только «погрузили» и «вернулось».
create or replace function private.event_items_before_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if private.my_role() = 'worker' and
     (new.event_id, new.item_id, new.qty) is distinct from (old.event_id, old.item_id, old.qty)
  then
    raise exception 'Кладовщик может отмечать только погрузку и возврат';
  end if;
  return new;
end $$;

drop trigger if exists event_items_before_update on public.event_items;
create trigger event_items_before_update
  before update on public.event_items
  for each row execute function private.event_items_before_update();

-- Журнал: само мероприятие.
create or replace function private.events_log()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare diff jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event', new.id, new.title, 'insert', null, auth.uid());
  elsif tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'updated_by', 'created_at');
    if diff is not null then
      insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
      values ('event', new.id, new.title, 'update', diff, auth.uid());
    end if;
  else
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event', old.id, old.title, 'delete', null, auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists events_log on public.events;
create trigger events_log
  after insert or update or delete on public.events
  for each row execute function private.events_log();

-- Журнал: что добавили / убрали / сколько поменяли в списке мероприятия.
-- Отметки погрузки и возврата не пишутся построчно — их итог виден по смене статуса.
create or replace function private.event_items_log()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare ev text; it text; eid bigint; iid bigint;
begin
  if tg_op = 'DELETE' then eid := old.event_id; iid := old.item_id;
  else eid := new.event_id; iid := new.item_id; end if;
  select title into ev from public.events where id = eid;
  if ev is null then return null; end if;              -- удаляется всё мероприятие целиком
  select name into it from public.items where id = iid;
  if tg_op = 'INSERT' then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event_line', eid, ev, 'insert', jsonb_build_object('_item', it, 'qty', jsonb_build_array(null, new.qty)), auth.uid());
  elsif tg_op = 'UPDATE' then
    if new.qty is distinct from old.qty then
      insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
      values ('event_line', eid, ev, 'update', jsonb_build_object('_item', it, 'qty', jsonb_build_array(old.qty, new.qty)), auth.uid());
    end if;
  else
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event_line', eid, ev, 'delete', jsonb_build_object('_item', it, 'qty', jsonb_build_array(old.qty, null)), auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists event_items_log on public.event_items;
create trigger event_items_log
  after insert or update or delete on public.event_items
  for each row execute function private.event_items_log();

revoke all on function private.events_before_write(), private.event_items_before_update(),
                       private.events_log(), private.event_items_log()
  from public, anon, authenticated;

-- ---------- Права ----------
--  Просмотр — видит всё; Кладовщик — отгружает и принимает возврат;
--  Менеджер и Администратор — создают, редактируют и удаляют мероприятия.
alter table public.events      enable row level security;
alter table public.event_items enable row level security;

drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated using (private.has_role('viewer'));
drop policy if exists events_insert on public.events;
create policy events_insert on public.events for insert to authenticated with check (private.has_role('manager'));
drop policy if exists events_update on public.events;
create policy events_update on public.events for update to authenticated using (private.has_role('worker')) with check (private.has_role('worker'));
drop policy if exists events_delete on public.events;
create policy events_delete on public.events for delete to authenticated using (private.has_role('manager'));

drop policy if exists event_items_select on public.event_items;
create policy event_items_select on public.event_items for select to authenticated using (private.has_role('viewer'));
drop policy if exists event_items_insert on public.event_items;
create policy event_items_insert on public.event_items for insert to authenticated with check (private.has_role('manager'));
drop policy if exists event_items_update on public.event_items;
create policy event_items_update on public.event_items for update to authenticated using (private.has_role('worker')) with check (private.has_role('worker'));
drop policy if exists event_items_delete on public.event_items;
create policy event_items_delete on public.event_items for delete to authenticated using (private.has_role('manager'));

revoke all on public.events, public.event_items from anon;

-- ---------- Обновления в реальном времени ----------
do $$ begin alter publication supabase_realtime add table public.events;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.event_items;
exception when duplicate_object then null; end $$;
alter table public.events      replica identity full;
alter table public.event_items replica identity full;
