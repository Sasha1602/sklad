-- =====================================================================
--  Склад проката — команда на мероприятии (дополнение к 02_events.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
--  Можно запускать повторно.
-- =====================================================================

-- Человек на выезде: либо сотрудник с аккаунтом (user_id),
-- либо человек без аккаунта (имя + телефон) — фрилансер, водитель, грузчик.
create table if not exists public.event_crew (
  id         bigint generated always as identity primary key,
  event_id   bigint not null references public.events(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  name       text,
  phone      text,
  job        text,          -- Свет, Звук, Водитель, Монтаж…
  note       text,
  created_at timestamptz not null default now(),
  check (user_id is not null or length(trim(coalesce(name, ''))) > 0)
);
create unique index if not exists event_crew_user_uniq on public.event_crew (event_id, user_id) where user_id is not null;
create index if not exists event_crew_event_idx on public.event_crew (event_id);

-- Журнал: кого добавили или убрали.
create or replace function private.event_crew_log()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare ev text; r_event bigint; r_user uuid; r_name text; r_job text; who text;
begin
  if tg_op = 'DELETE' then r_event := old.event_id; r_user := old.user_id; r_name := old.name; r_job := old.job;
  else r_event := new.event_id; r_user := new.user_id; r_name := new.name; r_job := new.job; end if;
  select title into ev from public.events where id = r_event;
  if ev is null then return null; end if;               -- удаляется всё мероприятие
  if r_user is not null then select coalesce(full_name, email) into who from public.profiles where id = r_user; end if;
  who := coalesce(who, r_name, 'человек');
  if tg_op = 'INSERT' then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event_crew', r_event, ev, 'insert', jsonb_build_object('_who', who, 'job', r_job), auth.uid());
  elsif tg_op = 'DELETE' then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event_crew', r_event, ev, 'delete', jsonb_build_object('_who', who, 'job', r_job), auth.uid());
  elsif (new.job, new.name, new.phone, new.user_id) is distinct from (old.job, old.name, old.phone, old.user_id) then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('event_crew', r_event, ev, 'update', jsonb_build_object('_who', who, 'job', r_job), auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists event_crew_log on public.event_crew;
create trigger event_crew_log
  after insert or update or delete on public.event_crew
  for each row execute function private.event_crew_log();

revoke all on function private.event_crew_log() from public, anon, authenticated;

-- Права: видят все с доступом, составляют команду менеджеры и администраторы.
alter table public.event_crew enable row level security;

drop policy if exists event_crew_select on public.event_crew;
create policy event_crew_select on public.event_crew for select to authenticated using (private.has_role('viewer'));
drop policy if exists event_crew_insert on public.event_crew;
create policy event_crew_insert on public.event_crew for insert to authenticated with check (private.has_role('manager'));
drop policy if exists event_crew_update on public.event_crew;
create policy event_crew_update on public.event_crew for update to authenticated using (private.has_role('manager')) with check (private.has_role('manager'));
drop policy if exists event_crew_delete on public.event_crew;
create policy event_crew_delete on public.event_crew for delete to authenticated using (private.has_role('manager'));

revoke all on public.event_crew from anon;

do $$ begin alter publication supabase_realtime add table public.event_crew;
exception when duplicate_object then null; end $$;
alter table public.event_crew replica identity full;
