-- =====================================================================
--  Склад проката — схема базы для Supabase
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
-- =====================================================================

-- Роли по возрастанию прав. Порядок важен: сравнение идёт по нему.
--   pending  — зарегистрировался, ждёт одобрения, ничего не видит
--   viewer   — только просмотр склада и журнала
--   worker   — кладовщик: меняет количество, состояние, статус, примечание
--   manager  — менеджер: полный доступ к оборудованию (добавить/изменить/удалить)
--   admin    — всё то же + управление пользователями и ролями
do $$ begin
  create type public.app_role as enum ('pending','viewer','worker','manager','admin');
exception when duplicate_object then null; end $$;

-- ---------- Профили пользователей ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       public.app_role not null default 'pending',
  created_at timestamptz not null default now()
);

-- ---------- Оборудование ----------
create table if not exists public.items (
  id         bigint generated always as identity primary key,
  name       text not null check (length(trim(name)) > 0),
  category   text,
  place      text,
  maker      text,
  model      text,
  inv        text,
  serial     text,
  unit       text not null default 'шт.',
  qty_fact   numeric check (qty_fact is null or qty_fact >= 0),
  qty_plan   numeric check (qty_plan is null or qty_plan >= 0),
  price      numeric check (price is null or price >= 0),
  state      text not null default 'Исправно',
  status     text not null default 'На складе',
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- ---------- Журнал изменений ----------
create table if not exists public.item_log (
  id         bigint generated always as identity primary key,
  item_id    bigint,
  item_name  text,
  action     text not null,          -- insert | update | delete
  changes    jsonb,                  -- {поле: [было, стало]}
  user_id    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists item_log_created_idx on public.item_log (created_at desc);

-- ---------- Служебные функции ----------
-- Живут в закрытой схеме private: её не видно через API сайта.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.my_role()
returns public.app_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function private.has_role(min_role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(private.my_role() >= min_role, false) $$;

-- Новый пользователь получает профиль. Самый первый становится админом.
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles where role = 'admin') then 'pending'::public.app_role
         else 'admin'::public.app_role end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Админ не может снять админа с себя и нельзя остаться без админов.
create or replace function private.profiles_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and new.id = auth.uid() and new.role is distinct from old.role then
    raise exception 'Нельзя менять свою собственную роль';
  end if;
  if old.role = 'admin' and new.role <> 'admin'
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'Должен остаться хотя бы один администратор';
  end if;
  new.id := old.id; new.email := old.email; new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function private.profiles_guard();

-- Кладовщик меняет только количество факт, состояние, статус и примечание.
-- Служебные поля ставит сама база.
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

drop trigger if exists items_before_write on public.items;
create trigger items_before_write
  before insert or update on public.items
  for each row execute function private.items_before_write();

-- Запись в журнал.
create or replace function private.items_log()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare diff jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.item_log (item_id, item_name, action, changes, user_id)
    values (new.id, new.name, 'insert', null, auth.uid());
  elsif tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'updated_by', 'created_at');
    if diff is not null then
      insert into public.item_log (item_id, item_name, action, changes, user_id)
      values (new.id, new.name, 'update', diff, auth.uid());
    end if;
  else
    insert into public.item_log (item_id, item_name, action, changes, user_id)
    values (old.id, old.name, 'delete', null, auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists items_log on public.items;
create trigger items_log
  after insert or update or delete on public.items
  for each row execute function private.items_log();

-- ---------- Права доступа (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.items    enable row level security;
alter table public.item_log enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or private.has_role('viewer'));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

drop policy if exists items_select on public.items;
create policy items_select on public.items for select to authenticated
  using (private.has_role('viewer'));

drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert to authenticated
  with check (private.has_role('manager'));

drop policy if exists items_update on public.items;
create policy items_update on public.items for update to authenticated
  using (private.has_role('worker')) with check (private.has_role('worker'));

drop policy if exists items_delete on public.items;
create policy items_delete on public.items for delete to authenticated
  using (private.has_role('manager'));

drop policy if exists item_log_select on public.item_log;
create policy item_log_select on public.item_log for select to authenticated
  using (private.has_role('viewer'));

-- Проверка ролей нужна правилам доступа — её может вызывать только вошедший пользователь.
revoke all on function private.my_role(), private.has_role(public.app_role) from public, anon;
grant execute on function private.my_role(), private.has_role(public.app_role) to authenticated;
-- Функции триггеров не должен вызывать никто напрямую.
revoke all on function private.handle_new_user(), private.profiles_guard(), private.items_before_write(), private.items_log()
  from public, anon, authenticated;

-- Анонимным посетителям — ничего.
revoke all on public.profiles, public.items, public.item_log from anon;

-- ---------- Обновления в реальном времени ----------
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.item_log;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null; end $$;
alter table public.items replica identity full;
