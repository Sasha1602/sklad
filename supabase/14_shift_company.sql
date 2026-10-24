-- =====================================================================
--  Склад проката — компания у смен (приложение «Смены»)
--  В кружке календаря вместо Д/Н показывается сокращение компании,
--  где стоит смена (например RU) — как в Supershift.
--  Запустить один раз после 12_shifts.sql: SQL Editor → Run. Можно повторно.
-- =====================================================================

alter table public.shift_types add column if not exists company text;
alter table public.shift_types drop constraint if exists shift_types_company_len;
alter table public.shift_types add constraint shift_types_company_len
  check (company is null or length(company) between 1 and 4);

notify pgrst, 'reload schema';

select count(*) filter (where company is not null) as "смен с компанией", count(*) as "всего смен" from public.shift_types;
