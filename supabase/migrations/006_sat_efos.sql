-- ════════════════════════════════════════════════════════════════════════════
-- 006 — Lista 69-B del SAT (EFOS: Empresas que Facturan Operaciones Simuladas)
-- ════════════════════════════════════════════════════════════════════════════
-- Cargada por la Edge Function sat-efos desde el listado público del SAT.
-- Se cruza contra los proveedores (rfc_emisor de cfdis) para alertar al usuario.
-- Es información PÚBLICA del SAT — lectura para todos los usuarios autenticados.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists sat_efos (
  rfc          text primary key,
  nombre       text,
  situacion    text,              -- Presunto | Definitivo | Desvirtuado | Sentencia Favorable
  oficio_presuncion text,
  fecha_presuncion  text,
  oficio_definitivo text,
  fecha_definitivo  text,
  actualizado  timestamptz default now()
);
create index if not exists idx_efos_situacion on sat_efos (situacion);

alter table sat_efos enable row level security;
create policy "efos lectura autenticados" on sat_efos for select to authenticated using (true);
grant select on sat_efos to authenticated;
grant all on sat_efos to service_role;
