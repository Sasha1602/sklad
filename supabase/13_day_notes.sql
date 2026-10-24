-- =====================================================================
--  Склад проката — личные заметки на дни (приложение «Смены»)
--  Запустить один раз после 12_shifts.sql: SQL Editor → Run. Можно повторно.
--
--  Заметку видит ТОЛЬКО её автор: ни менеджер, ни админ через сайт
--  или приложение «Склад» её не прочитают. Сайт и календарь-подписка
--  эту таблицу не читают вообще.
-- =====================================================================

create table if not exists public.day_notes (
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  day        date not null,
  text       text not null check (length(trim(text)) > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.day_notes enable row level security;
drop policy if exists day_notes_own on public.day_notes;
create policy day_notes_own on public.day_notes for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
revoke all on public.day_notes from anon;
grant select, insert, update, delete on public.day_notes to authenticated;
-- В realtime не добавляем: заметки никуда не рассылаются.

-- Старые заметки из отметок дней (их видел склад) — перенести в личные и стереть.
insert into public.day_notes (user_id, day, text)
select user_id, day, trim(note) from public.staff_days
where note is not null and length(trim(note)) > 0
on conflict (user_id, day) do nothing;
update public.staff_days set note = null where note is not null;

select (select count(*) from public.day_notes) as "заметок";
