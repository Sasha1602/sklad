// Настройки подключения к Supabase.
// Где взять: Supabase → Project Settings → API (или «Connect»).
// Этот ключ публичный (anon / publishable), его можно хранить на GitHub:
// защиту данных обеспечивают права в базе (schema.sql), а не секретность ключа.
// НИКОГДА не вставляйте сюда service_role / secret ключ.
window.SKLAD_CONFIG = {
  SUPABASE_URL: "https://ВАШ-ПРОЕКТ.supabase.co",
  SUPABASE_KEY: "ВСТАВЬТЕ_ANON_ИЛИ_PUBLISHABLE_КЛЮЧ",
  TITLE: "Склад проката"
};
