-- ════════════════════════════════════════════════════════════════════════════
-- 005 — Almacén central de CFDI en Supabase
-- ════════════════════════════════════════════════════════════════════════════
-- Los CFDI descargados del SAT (Edge Function sat-descarga) se persisten aquí.
-- Permite el flujo DESATENDIDO (cron) sin pasar por el navegador.
-- Dedup por (org_id, uuid).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists cfdis (
  org_id           uuid not null references organizaciones(id) on delete cascade,
  uuid             text not null,
  tipo             text,                 -- 'emitido' | 'recibido'
  version          text,
  fecha            timestamptz,
  serie            text,
  folio            text,
  subtotal         numeric(18,2),
  total            numeric(18,2),
  moneda           text,
  tipo_comprobante text,                 -- I/E/T/N/P
  forma_pago       text,
  metodo_pago      text,
  rfc_emisor       text,
  nombre_emisor    text,
  rfc_receptor     text,
  nombre_receptor  text,
  estado           text default 'vigente',
  xml              text,                 -- XML completo del CFDI
  creado           timestamptz default now(),
  primary key (org_id, uuid)
);

create index if not exists idx_cfdis_org_fecha on cfdis (org_id, fecha desc);
create index if not exists idx_cfdis_org_tipo  on cfdis (org_id, tipo);

alter table cfdis enable row level security;

create policy "ver cfdis de mis orgs" on cfdis
  for select using (org_id in (select my_org_ids()));

create policy "gestionar cfdis de mis orgs" on cfdis
  for all using (
    org_id in (select org_id from user_org where user_id = auth.uid() and rol in ('owner','admin'))
  );

grant select, insert, update, delete on cfdis to authenticated;
