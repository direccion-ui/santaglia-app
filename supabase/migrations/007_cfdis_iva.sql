-- ════════════════════════════════════════════════════════════════════════════
-- 007 — Columnas de IVA en cfdis (extraídas del XML por el parser server-side)
-- ════════════════════════════════════════════════════════════════════════════
-- IVA real por tasa (no se aproxima con 16%). Base para el cruce de IVA mensual.
-- ════════════════════════════════════════════════════════════════════════════
alter table cfdis add column if not exists iva_16       numeric(18,2) default 0;  -- IVA trasladado 16%
alter table cfdis add column if not exists iva_8        numeric(18,2) default 0;  -- IVA frontera 8%
alter table cfdis add column if not exists iva_0_base   numeric(18,2) default 0;  -- base tasa 0%
alter table cfdis add column if not exists exento_base  numeric(18,2) default 0;  -- base exenta
alter table cfdis add column if not exists iva_retenido numeric(18,2) default 0;  -- IVA retenido
