-- =====================================================================
--  Склад проката — «Смены»: зарплата, обмены сменами, ответ на выезд
--  Запустить один раз после 12–14: SQL Editor → Run. Можно повторно.
--
--  Зарплата и обмены — личные: видит только сам человек (как заметки).
--  Ответ «Смогу / Не смогу» на выезд видят менеджеры на сайте и в «Складе».
-- =====================================================================

-- Настройки зарплаты человека: ставки по сменам, ночные, праздничные (одна строка JSON).
create table if not exists public.pay_settings (
  user_id    uuid primary key references public.profiles(id) on delete cascade default auth.uid(),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Обмены сменами с коллегами по основной работе.
--   gave — отдал свою смену (коллега вышел за меня), took — взял смену за коллегу.
create table if not exists public.shift_swaps (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  day        date not null,
  kind       text not null check (kind in ('gave', 'took')),
  with_name  text not null check (length(trim(with_name)) > 0),
  note       text,
  settled    boolean not null default false,       -- рассчитались (смену вернули)
  created_at timestamptz not null default now()
);
create index if not exists shift_swaps_user_idx on public.shift_swaps (user_id, day);

alter table public.pay_settings enable row level security;
alter table public.shift_swaps enable row level security;
drop policy if exists pay_settings_own on public.pay_settings;
create policy pay_settings_own on public.pay_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists shift_swaps_own on public.shift_swaps;
create policy shift_swaps_own on public.shift_swaps for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.pay_settings, public.shift_swaps from anon;
grant select, insert, update, delete on public.pay_settings, public.shift_swaps to authenticated;
-- В realtime не добавляем: эти данные никуда не рассылаются.

-- ---------------------------------------------------------------------
-- Ответ на выезд: «Смогу» / «Не смогу» + причина.
alter table public.event_crew add column if not exists reply      text;
alter table public.event_crew add column if not exists reply_note text;
alter table public.event_crew add column if not exists replied_at timestamptz;
alter table public.event_crew drop constraint if exists event_crew_reply_chk;
alter table public.event_crew add constraint event_crew_reply_chk check (reply is null or reply in ('yes', 'no'));

-- Человек отвечает только за себя (менять event_crew напрямую может лишь менеджер).
create or replace function public.crew_reply(p_event bigint, p_reply text, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare cid bigint;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if p_reply is not null and p_reply not in ('yes', 'no') then raise exception 'Ответ: yes, no или пусто'; end if;
  update public.event_crew
     set reply = p_reply,
         reply_note = nullif(trim(coalesce(p_note, '')), ''),
         replied_at = case when p_reply is null then null else now() end
   where event_id = p_event and user_id = auth.uid()
  returning id into cid;
  if cid is null then raise exception 'Вас нет в команде этого выезда'; end if;
  if p_reply is not null then perform private.notify('crew_reply', cid); end if;
end $$;
revoke all on function public.crew_reply(bigint, text, text) from public, anon;
grant execute on function public.crew_reply(bigint, text, text) to authenticated;

-- Если человека поменяли в строке команды — старый ответ больше не действует.
create or replace function private.event_crew_reply_reset()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id then
    new.reply := null; new.reply_note := null; new.replied_at := null;
  end if;
  return new;
end $$;
drop trigger if exists event_crew_reply_reset on public.event_crew;
create trigger event_crew_reply_reset before update of user_id on public.event_crew
  for each row execute function private.event_crew_reply_reset();

notify pgrst, 'reload schema';

select (select count(*) from public.pay_settings) as "настроек зарплаты",
       (select count(*) from public.shift_swaps) as "обменов",
       (select count(*) filter (where reply is not null) from public.event_crew) as "ответов на выезды";
