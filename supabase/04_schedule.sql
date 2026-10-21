-- =====================================================================
--  Склад проката — графики сотрудников (дополнение к 03_crew.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
--  Можно запускать повторно.
-- =====================================================================

-- График основной работы: work_days рабочих, затем off_days выходных, по кругу.
-- anchor — любой первый день смены по этому графику (например, последняя смена).
create table if not exists public.staff_schedule (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  label      text not null default 'Основная работа',
  work_days  int  not null check (work_days between 1 and 14),
  off_days   int  not null check (off_days between 0 and 28),
  anchor     date not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- Периоды-исключения:
--   free — график основной работы не действует (отпуск/больничный на основной работе) → человек свободен;
--   busy — человек недоступен совсем (уехал, болеет, свои дела).
create table if not exists public.staff_periods (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('free','busy')),
  date_from  date not null,
  date_to    date not null,
  note       text,
  created_at timestamptz not null default now(),
  check (date_to >= date_from)
);
create index if not exists staff_periods_user_idx on public.staff_periods (user_id, date_from);

create or replace function private.staff_schedule_stamp()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists staff_schedule_stamp on public.staff_schedule;
create trigger staff_schedule_stamp before insert or update on public.staff_schedule
  for each row execute function private.staff_schedule_stamp();
revoke all on function private.staff_schedule_stamp() from public, anon, authenticated;

-- Права: видят все с доступом; меняют менеджеры и администраторы — любой график,
-- а каждый сотрудник — свой собственный.
alter table public.staff_schedule enable row level security;
alter table public.staff_periods  enable row level security;

drop policy if exists staff_schedule_select on public.staff_schedule;
create policy staff_schedule_select on public.staff_schedule for select to authenticated using (private.has_role('viewer'));
drop policy if exists staff_schedule_write on public.staff_schedule;
create policy staff_schedule_write on public.staff_schedule for all to authenticated
  using (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')))
  with check (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')));

drop policy if exists staff_periods_select on public.staff_periods;
create policy staff_periods_select on public.staff_periods for select to authenticated using (private.has_role('viewer'));
drop policy if exists staff_periods_write on public.staff_periods;
create policy staff_periods_write on public.staff_periods for all to authenticated
  using (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')))
  with check (private.has_role('manager') or (user_id = auth.uid() and private.has_role('viewer')));

revoke all on public.staff_schedule, public.staff_periods from anon;

do $$ begin alter publication supabase_realtime add table public.staff_schedule;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.staff_periods;
exception when duplicate_object then null; end $$;
alter table public.staff_schedule replica identity full;
alter table public.staff_periods  replica identity full;
