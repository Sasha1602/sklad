-- =====================================================================
--  Склад проката — смены сотрудников по дням (приложение «Смены»)
--  Дополнение к 04_schedule.sql. Запустить один раз: SQL Editor → Run.
--  Можно запускать повторно.
-- =====================================================================

-- Виды смен человека: «День 08–20», «Ночь», «Сутки», «Отгул»… — как в Supershift.
create table if not exists public.shift_types (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  name       text not null check (length(trim(name)) > 0),
  short      text not null check (length(short) between 1 and 3),   -- что пишется в клетке календаря
  color      text not null default '#F2A900',                       -- #RRGGBB
  start_time time,
  end_time   time,
  hours      numeric check (hours is null or hours >= 0),
  is_work    boolean not null default true,                          -- занят на основной работе (для склада)
  sort       int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists shift_types_user_idx on public.shift_types (user_id, sort);

-- Отметка на конкретный день поверх графика: другая смена, обмен, «выходной» (shift_type_id пусто).
create table if not exists public.staff_days (
  user_id       uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  day           date not null,
  shift_type_id bigint references public.shift_types(id) on delete cascade,
  note          text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);

-- Какой вид смены ставит график по кругу (1/3, 2/2…).
alter table public.staff_schedule add column if not exists shift_type_id bigint references public.shift_types(id) on delete set null;

-- Права как у графиков: видят все сотрудники (для «Кто свободен»), меняет сам человек или менеджер.
alter table public.shift_types enable row level security;
alter table public.staff_days enable row level security;
drop policy if exists shift_types_select on public.shift_types;
create policy shift_types_select on public.shift_types for select to authenticated using (private.has_role('viewer'));
drop policy if exists shift_types_write on public.shift_types;
create policy shift_types_write on public.shift_types for all to authenticated
  using (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')))
  with check (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')));
drop policy if exists staff_days_select on public.staff_days;
create policy staff_days_select on public.staff_days for select to authenticated using (private.has_role('viewer'));
drop policy if exists staff_days_write on public.staff_days;
create policy staff_days_write on public.staff_days for all to authenticated
  using (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')))
  with check (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')));
revoke all on public.shift_types, public.staff_days from anon;
grant select, insert, update, delete on public.shift_types, public.staff_days to authenticated;

do $$ begin alter publication supabase_realtime add table public.shift_types;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.staff_days;
exception when duplicate_object then null; when undefined_object then null; end $$;
alter table public.staff_days replica identity full;

-- У кого уже есть график — завести ему вид смены по названию графика и привязать.
insert into public.shift_types (user_id, name, short, color, is_work, sort)
select s.user_id, coalesce(nullif(trim(s.label), ''), 'Смена'), 'С', '#F2A900', true, 0
from public.staff_schedule s
where s.shift_type_id is null
  and not exists (select 1 from public.shift_types t where t.user_id = s.user_id);
update public.staff_schedule s set shift_type_id = t.id
from public.shift_types t
where s.shift_type_id is null and t.user_id = s.user_id and t.sort = 0;

select (select count(*) from public.shift_types) as "видов смен", (select count(*) from public.staff_days) as "отметок по дням";
