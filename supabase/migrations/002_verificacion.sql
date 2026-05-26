-- ============================================================
-- VERIFICACIÓN: Ejecuta esto en SQL Editor para confirmar
-- que todas las tablas y políticas quedaron creadas
-- ============================================================

SELECT
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns c
   WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columnas
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
