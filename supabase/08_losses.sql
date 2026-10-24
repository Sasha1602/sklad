-- =====================================================================
--  Склад проката — разбор недостач (дополнение к 07_push.sql)
--  Запустить один раз: Supabase → SQL Editor → New query → вставить → Run
--  Можно запускать повторно.
-- =====================================================================

-- Сколько из недостачи по строке мероприятия списано как потеря.
-- Открытая недостача = уехало − вернулось − списано.
alter table public.event_items add column if not exists written_off numeric not null default 0 check (written_off >= 0);

-- Кладовщик: погрузка, возврат и «нашёлся»; списывать — только менеджер.
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
    if new.written_off is distinct from old.written_off then
      raise exception 'Списывать потери может только менеджер';
    end if;
  end if;
  return new;
end $$;

-- Журнал: «нашёлся» и «списал».
create or replace function private.event_items_loss_log()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare ev text; it text; st text;
begin
  select title, status into ev, st from public.events where id = new.event_id;
  if st is distinct from 'returned' then return null; end if;
  select name into it from public.items where id = new.item_id;
  if old.qty_back is not null and new.qty_back > old.qty_back then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('loss', new.event_id, ev, 'found', jsonb_build_object('_item', it, 'n', new.qty_back - old.qty_back), auth.uid());
  end if;
  if new.written_off > old.written_off then
    insert into public.item_log (kind, item_id, item_name, action, changes, user_id)
    values ('loss', new.event_id, ev, 'written_off', jsonb_build_object('_item', it, 'n', new.written_off - old.written_off), auth.uid());
  end if;
  return null;
end $$;
drop trigger if exists event_items_loss_log on public.event_items;
create trigger event_items_loss_log after update on public.event_items
  for each row execute function private.event_items_loss_log();
revoke all on function private.event_items_loss_log() from public, anon, authenticated;

-- Списать потерю: одной операцией закрыть недостачу и уменьшить количество на складе.
-- Работает с правами того, кто вызывает (security invoker), поэтому RLS и проверки ролей действуют.
create or replace function public.write_off(line_id bigint, n numeric)
returns void
language plpgsql security invoker set search_path = public
as $$
declare l public.event_items; miss numeric;
begin
  if not private.has_role('manager') then raise exception 'Списывать потери может только менеджер'; end if;
  select * into l from public.event_items where id = line_id for update;
  if l.id is null then raise exception 'Строка мероприятия не найдена'; end if;
  miss := coalesce(l.qty_out, l.qty) - coalesce(l.qty_back, coalesce(l.qty_out, l.qty)) - l.written_off;
  if n is null or n <= 0 or n > miss then raise exception 'Можно списать от 1 до %', miss; end if;
  update public.event_items set written_off = written_off + n where id = line_id;
  update public.items set qty_fact = greatest(0, coalesce(qty_fact, 0) - n) where id = l.item_id;
end $$;
revoke all on function public.write_off(bigint, numeric) from public, anon;
grant execute on function public.write_off(bigint, numeric) to authenticated;
