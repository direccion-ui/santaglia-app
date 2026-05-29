/**
 * Santaglia Compass — sat-descarga
 * Edge Function (Deno) para la DESCARGA MASIVA DE CFDI del SAT.
 *
 * Flujo SAT (SOAP, 4 pasos):
 *   ① Autenticación      → token (5 min)
 *   ② SolicitaDescarga   → IdSolicitud
 *   ③ VerificaSolicitud  → estado + IdsPaquetes (polling)
 *   ④ Descarga           → ZIP (base64) → XMLs
 *
 * Acciones (POST JSON { accion, ... }):
 *   'solicitar' { tipo:'emitidos'|'recibidos', fechaIni, fechaFin } → crea solicitud
 *   'verificar' { idSolicitud }                                     → estado + paquetes
 *   'descargar' { idPaquete }                                       → XMLs (base64 ZIP)
 *
 * La e.firma se lee de sat_credenciales (descifrada en memoria, nunca al cliente).
 *
 * ⚠️ La FIRMA FIEL de los sobres SOAP (canonicalización + RSA) está marcada como
 *    TODO: requiere la e.firma real y pruebas iterativas contra el SAT. Las
 *    plantillas SOAP y los endpoints sí son los oficiales.
 *
 * Variables de entorno: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *                       SAT_KEY_ENC_SECRET (clave AES para descifrar la .key)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

/* Endpoints oficiales del servicio de Descarga Masiva del SAT */
const SAT = {
  auth:     'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/Autenticacion/Autenticacion.svc',
  solicita: 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/SolicitaDescargaService.svc',
  verifica: 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/VerificaSolicitudDescargaService.svc',
  descarga: 'https://cfdidescargamasiva.clouda.sat.gob.mx/DescargaService.svc',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  /* ── Auth: sesión Supabase del usuario ── */
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

  const sbUser = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await sbUser.auth.getUser();
  if (authErr || !user) return json({ error: 'Sesión inválida' }, 401);

  /* Cliente con service role para leer credenciales / escribir solicitudes */
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const accion = body.accion;

  try {
    /* Resolver org del usuario */
    const { data: prof } = await sb.from('profiles').select('current_org_id').eq('id', user.id).single();
    const orgId = prof?.current_org_id;
    if (!orgId) return json({ error: 'Usuario sin organización' }, 400);

    /* ── Guardar e.firma (cifra la .key con AES-GCM y la persiste) ── */
    if (accion === 'guardar_efirma') {
      const { rfc, cerB64, keyB64, pass } = body;
      if (!rfc || !cerB64 || !keyB64 || !pass) return json({ error: 'Faltan datos de la e.firma' }, 400);
      /* La .key (DER, posiblemente cifrada con su contraseña) + la contraseña se
         cifran juntas con AES-GCM usando SAT_KEY_ENC_SECRET. El backend la
         descifra solo en memoria al firmar. */
      const { cifrado, iv } = await aesEncrypt(JSON.stringify({ keyB64, pass }));
      const { error } = await sb.from('sat_credenciales').upsert({
        org_id: orgId, rfc, cer_b64: cerB64, key_cifrada: cifrado, key_iv: iv,
        modo: 'persistido', actualizado: new Date().toISOString(),
      }, { onConflict: 'org_id' });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    /* Cargar credenciales e.firma de la org */
    const { data: cred } = await sb.from('sat_credenciales').select('*').eq('org_id', orgId).single();
    if (!cred) return json({ error: 'Sin e.firma configurada. Súbela en Configuración → Conexión SAT.' }, 400);

    /* Descifrar la llave privada (AES-GCM con SAT_KEY_ENC_SECRET) — solo en memoria */
    const keyPem = await descifrarKey(cred.key_cifrada, cred.key_iv);   // TODO firma real

    switch (accion) {
      case 'solicitar': {
        const { tipo, fechaIni, fechaFin } = body;
        const token = await autenticar(cred.cer_b64, keyPem);            // ① TODO firma FIEL
        const idSolicitud = await solicitarDescarga(token, cred.rfc, tipo, fechaIni, fechaFin, cred.cer_b64, keyPem); // ②
        const { data: sol } = await sb.from('sat_solicitudes').insert({
          org_id: orgId, id_solicitud: idSolicitud, tipo, fecha_ini: fechaIni, fecha_fin: fechaFin, estado: 'solicitada',
        }).select().single();
        return json({ ok: true, idSolicitud, solicitud: sol });
      }

      case 'verificar': {
        const token = await autenticar(cred.cer_b64, keyPem);
        const res = await verificarSolicitud(token, cred.rfc, body.idSolicitud, cred.cer_b64, keyPem); // ③
        await sb.from('sat_solicitudes').update({
          estado: res.estado, paquetes: res.paquetes, mensaje: res.mensaje, actualizado: new Date().toISOString(),
        }).eq('id_solicitud', body.idSolicitud).eq('org_id', orgId);
        return json({ ok: true, ...res });
      }

      case 'descargar': {
        const token = await autenticar(cred.cer_b64, keyPem);
        const zipB64 = await descargarPaquete(token, cred.rfc, body.idPaquete, cred.cer_b64, keyPem); // ④
        /* El cliente descomprime el ZIP y llama StglCFDI.importar() con los XML.
           (Descomprimir aquí también es posible con una lib de zip de Deno.) */
        return json({ ok: true, zipB64 });
      }

      default:
        return json({ error: 'Acción no reconocida' }, 400);
    }
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   PASOS DEL SAT — ⚠️ La FIRMA FIEL requiere la e.firma real + pruebas contra SAT.
   Aquí queda la ESTRUCTURA con los sobres SOAP oficiales y los puntos a completar.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Cifrado AES-GCM de la e.firma (IMPLEMENTADO — testeable) ──────────────── */
async function _aesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('SAT_KEY_ENC_SECRET') ?? '';
  if (!secret) throw new Error('Falta SAT_KEY_ENC_SECRET en el entorno');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function aesEncrypt(plain: string): Promise<{ cifrado: string; iv: string }> {
  const key = await _aesKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return { cifrado: b64(new Uint8Array(buf)), iv: b64(iv) };
}
async function aesDecrypt(cifrado: string, ivB64: string): Promise<string> {
  const key = await _aesKey();
  const bin = (b: string) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bin(ivB64) }, key, bin(cifrado));
  return new TextDecoder().decode(buf);
}

async function descifrarKey(keyCifrada: string, iv: string): Promise<string> {
  /* Devuelve { keyB64, pass } de la e.firma (descifrado solo en memoria). */
  return await aesDecrypt(keyCifrada, iv);
}

async function autenticar(_cerB64: string, _keyPem: string): Promise<string> {
  // ① Construir sobre SOAP de Autenticación con WS-Security:
  //    - Timestamp (Created/Expires, 5 min)
  //    - BinarySecurityToken = certificado
  //    - Signature (RSA-SHA1) sobre el Timestamp canonicalizado (Exclusive C14N)
  //    POST a SAT.auth → respuesta contiene el <Token> (xenc) para Authorization.
  // TODO: firma FIEL + parseo de respuesta.
  throw new Error('autenticar: pendiente — requiere firma FIEL real');
}

async function solicitarDescarga(_token: string, _rfc: string, _tipo: string,
  _fIni: string, _fFin: string, _cerB64: string, _keyPem: string): Promise<string> {
  // ② SOAP SolicitaDescarga firmado con la FIEL:
  //    <solicitud RfcSolicitante FechaInicial FechaFinal TipoSolicitud
  //               RfcEmisor|RfcReceptor> + <Signature>
  //    POST a SAT.solicita con header Authorization: WRAP access_token="token"
  //    → devuelve IdSolicitud.
  throw new Error('solicitarDescarga: pendiente — requiere firma FIEL real');
}

async function verificarSolicitud(_token: string, _rfc: string, _idSolicitud: string,
  _cerB64: string, _keyPem: string): Promise<{ estado: string; paquetes: string[]; mensaje: string }> {
  // ③ SOAP VerificaSolicitudDescarga firmado → EstadoSolicitud (1..5) + IdsPaquetes.
  //    Estado 3 = Terminada (lista para descargar).
  throw new Error('verificarSolicitud: pendiente — requiere firma FIEL real');
}

async function descargarPaquete(_token: string, _rfc: string, _idPaquete: string,
  _cerB64: string, _keyPem: string): Promise<string> {
  // ④ SOAP Descarga firmado → <Paquete> = ZIP en base64.
  throw new Error('descargarPaquete: pendiente — requiere firma FIEL real');
}
