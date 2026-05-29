-- ════════════════════════════════════════════════════════════════════════════
-- 004 — Conexión automática con el SAT (Descarga Masiva de CFDI)
-- ════════════════════════════════════════════════════════════════════════════
-- La e.firma (FIEL) se usa SOLO en el backend (Edge Function sat-descarga).
-- La llave privada se guarda CIFRADA (nunca en claro, nunca en el frontend).
-- ════════════════════════════════════════════════════════════════════════════

-- ── Credenciales e.firma por organización ──────────────────────────────────
create table if not exists sat_credenciales (
  org_id      text primary key,
  rfc         text not null,
  cer_b64     text,                 -- certificado público (.cer) — ok en claro
  key_cifrada text,                 -- llave privada (.key) CIFRADA (AES-GCM)
  key_iv      text,                 -- IV de la encripción
  modo        text default 'persistido',   -- 'persistido' | 'sesion'
  actualizado timestamptz default now()
);
alter table sat_credenciales enable row level security;

-- Solo el dueño de la org ve/edita sus credenciales
create policy "sat_cred_own_org" on sat_credenciales
  for all using (
    org_id = (select current_org_id from profiles where id = auth.uid())
  );

-- ── Solicitudes de descarga (auditoría + reanudar polling asíncrono) ────────
create table if not exists sat_solicitudes (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null,
  id_solicitud  text,                       -- IdSolicitud devuelto por el SAT
  tipo          text,                       -- 'emitidos' | 'recibidos'
  tipo_solicitud text default 'CFDI',       -- 'CFDI' | 'Metadata'
  fecha_ini     date,
  fecha_fin     date,
  estado        text default 'nueva',       -- nueva|solicitada|verificando|lista|descargada|error
  mensaje       text,                        -- detalle de error o estado
  paquetes      jsonb default '[]',          -- IdsPaquetes del SAT
  cfdis_nuevos  int  default 0,
  creado        timestamptz default now(),
  actualizado   timestamptz default now()
);
alter table sat_solicitudes enable row level security;

create policy "sat_sol_own_org" on sat_solicitudes
  for all using (
    org_id = (select current_org_id from profiles where id = auth.uid())
  );

create index if not exists idx_sat_sol_org    on sat_solicitudes (org_id);
create index if not exists idx_sat_sol_estado on sat_solicitudes (estado);
