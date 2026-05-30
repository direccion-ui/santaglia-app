/**
 * Santaglia Compass — sat-efos
 * Edge Function (Deno) que descarga el "Listado completo 69-B" del SAT (EFOS:
 * Empresas que Facturan Operaciones Simuladas) y lo carga a la tabla sat_efos.
 *
 * Fuente oficial (datos abiertos SAT, CSV ~4.5 MB, encoding ISO-8859-1):
 *   http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv
 *
 * Se invoca por cron (header x-cron-secret) o manualmente con sesión Supabase.
 * Variables de entorno: SUPABASE_URL, SUPABASE_ANON_KEY, SAT_SERVICE_KEY, SAT_CRON_SECRET.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Content-Type': 'application/json',
};
const EFOS_URL = 'http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

/* Parser CSV simple que respeta comillas dobles (campos con comas internas). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // ── Auth: cron (secreto) o sesión de usuario ──
  const cronSecret = req.headers.get('x-cron-secret');
  let admin;
  if (cronSecret) {
    if (cronSecret !== (Deno.env.get('SAT_CRON_SECRET') ?? '\0')) return json({ error: 'cron secret inválido' }, 401);
    const svc = Deno.env.get('SAT_SERVICE_KEY') ?? '';
    if (!svc) return json({ error: 'Falta SAT_SERVICE_KEY' }, 500);
    admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', svc);
  } else {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const sbUser = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await sbUser.auth.getUser();
    if (!user) return json({ error: 'Sesión inválida' }, 401);
    const svc = Deno.env.get('SAT_SERVICE_KEY') ?? '';
    admin = svc ? createClient(Deno.env.get('SUPABASE_URL') ?? '', svc) : sbUser;
  }

  try {
    // 1) Descargar el CSV (ISO-8859-1 → UTF-8)
    const r = await fetch(EFOS_URL);
    if (!r.ok) return json({ error: `SAT ${r.status} al descargar la lista 69-B` }, 502);
    const buf = await r.arrayBuffer();
    const texto = new TextDecoder('iso-8859-1').decode(buf);
    const lineas = texto.split(/\r?\n/);

    // 2) Localizar la fila de encabezados (empieza con "No,RFC,")
    let hi = lineas.findIndex(l => /^No,RFC,/.test(l));
    if (hi < 0) hi = 2;  // fallback: las 3 primeras filas son metadatos

    // 3) Parsear filas → registros
    const filas: any[] = [];
    for (let i = hi + 1; i < lineas.length; i++) {
      const ln = lineas[i];
      if (!ln || !ln.trim()) continue;
      const c = parseCsvLine(ln);
      const rfc = (c[1] || '').trim().toUpperCase();
      if (!rfc) continue;
      filas.push({
        rfc,
        nombre:            (c[2] || '').trim(),
        situacion:         (c[3] || '').trim(),
        oficio_presuncion: (c[4] || '').trim() || null,
        fecha_presuncion:  (c[5] || '').trim() || null,
        oficio_definitivo: (c[8] || '').trim() || null,
        fecha_definitivo:  (c[9] || '').trim() || null,
        actualizado:       new Date().toISOString(),
      });
    }

    if (!filas.length) return json({ error: 'No se parsearon filas del CSV', muestra: lineas.slice(0, 5) }, 500);

    // 4) Upsert en bloques (dedup por rfc; conservar el último registro por RFC)
    const porRfc = new Map<string, any>();
    for (const f of filas) porRfc.set(f.rfc, f);  // el último gana
    const unicos = [...porRfc.values()];

    let guardados = 0;
    for (let i = 0; i < unicos.length; i += 500) {
      const lote = unicos.slice(i, i + 500);
      const { error } = await admin.from('sat_efos').upsert(lote, { onConflict: 'rfc' });
      if (error) return json({ error: 'Upsert sat_efos: ' + error.message, guardados }, 500);
      guardados += lote.length;
    }

    // Conteo por situación (informativo)
    const conteo: Record<string, number> = {};
    for (const f of unicos) conteo[f.situacion] = (conteo[f.situacion] || 0) + 1;

    return json({ ok: true, total: filas.length, unicos: unicos.length, guardados, situaciones: conteo });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
