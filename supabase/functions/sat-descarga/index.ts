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
import forge from 'https://esm.sh/node-forge@1.3.1'
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Content-Type': 'application/json',
};

/* Endpoints oficiales del servicio de Descarga Masiva del SAT */
const SAT = {
  auth:     'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/Autenticacion/Autenticacion.svc',
  solicita: 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/SolicitaDescargaService.svc',
  verifica: 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/VerificaSolicitudDescargaService.svc',
  descarga: 'https://cfdidescargamasiva.clouda.sat.gob.mx/DescargaMasivaService.svc',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  /* ── Modo CRON (desatendido): autenticado por secreto compartido, NO por sesión.
        Usa el service role para operar sobre todas las orgs conectadas. ── */
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    if (cronSecret !== (Deno.env.get('SAT_CRON_SECRET') ?? '\0'))
      return json({ error: 'cron secret inválido' }, 401);
    const svcKey = Deno.env.get('SAT_SERVICE_KEY') ?? '';
    if (!svcKey) return json({ error: 'Falta SAT_SERVICE_KEY en el entorno' }, 500);
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', svcKey);
    try {
      const resultados = await cronTick(admin);
      return json({ ok: true, resultados });
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }

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

  /* Todas las operaciones usan el cliente del usuario (sbUser): RLS garantiza que
     solo accede a su propia org. No se necesita service role. */

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const accion = body.accion;

  try {
    /* Resolver org del usuario — con el cliente del usuario (RLS: perfil propio) */
    const { data: prof } = await sbUser.from('profiles').select('current_org_id').eq('id', user.id).single();
    const orgId = prof?.current_org_id;
    if (!orgId) return json({ error: 'Usuario sin organización' }, 400);

    /* ── Guardar e.firma (cifra la .key con AES-GCM y la persiste) ── */
    if (accion === 'guardar_efirma') {
      const { rfc, cerB64, keyB64, pass } = body;
      if (!rfc || !cerB64 || !keyB64 || !pass) return json({ error: 'Faltan datos de la e.firma' }, 400);
      /* La .key (DER, cifrada con su contraseña) + la contraseña se cifran juntas
         con AES-GCM (SAT_KEY_ENC_SECRET). Se guardan en el esquema existente:
         key_encrypted = JSON {iv,cifrado}; cer_encrypted = .cer en base64. */
      const { cifrado, iv } = await aesEncrypt(JSON.stringify({ keyB64, pass }));
      const { error } = await sbUser.from('sat_credenciales').upsert({
        org_id: orgId, rfc,
        cer_encrypted: cerB64,
        key_encrypted: JSON.stringify({ iv, cifrado }),
        conectado: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id' });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    /* Cargar credenciales e.firma de la org */
    const { data: cred } = await sbUser.from('sat_credenciales').select('*').eq('org_id', orgId).single();
    if (!cred) return json({ error: 'Sin e.firma configurada. Súbela en Configuración → Conexión SAT.' }, 400);

    /* Descifrar la e.firma (AES-GCM) y cargarla en forge — solo en memoria */
    if (!cred.key_encrypted || !cred.cer_encrypted)
      return json({ error: 'La e.firma no está completa. Vuelve a guardarla en Configuración → Conexión SAT.' }, 400);
    const { iv, cifrado } = JSON.parse(cred.key_encrypted);
    const { keyB64, pass } = JSON.parse(await aesDecrypt(cifrado, iv));
    const efirma = cargarEfirma(cred.cer_encrypted, keyB64, pass);

    switch (accion) {
      case 'autenticar': {   /* paso ① aislado — útil para PROBAR la firma FIEL */
        const token = await autenticar(efirma);
        return json({ ok: true, token: token.slice(0, 24) + '…', autenticado: true });
      }

      case 'reprocesar_iva': {
        /* Re-extrae el IVA del XML de los CFDIs ya guardados (sin tocar el SAT). */
        const { data: rows, error } = await sbUser.from('cfdis')
          .select('org_id,uuid,xml').eq('org_id', orgId);
        if (error) return json({ error: error.message }, 500);
        let actualizados = 0;
        const updates: any[] = [];
        for (const row of rows || []) {
          if (!row.xml) continue;
          const iva = _extraerIVA(row.xml);
          updates.push({
            org_id: row.org_id, uuid: row.uuid,
            iva_16: iva.iva16, iva_8: iva.iva8, iva_0_base: iva.iva0_base,
            exento_base: iva.exento_base, iva_retenido: iva.iva_ret,
          });
        }
        for (let i = 0; i < updates.length; i += 200) {
          const lote = updates.slice(i, i + 200);
          const { error: e2 } = await sbUser.from('cfdis').upsert(lote, { onConflict: 'org_id,uuid' });
          if (e2) return json({ error: 'Upsert: ' + e2.message, actualizados }, 500);
          actualizados += lote.length;
        }
        return json({ ok: true, total: rows?.length || 0, actualizados });
      }

      case 'solicitar': {
        const { tipo, fechaIni, fechaFin } = body;
        const token = await autenticar(efirma);                          // ①
        const idSolicitud = await solicitarDescarga(efirma, token, cred.rfc, tipo, fechaIni, fechaFin); // ②
        /* Historial en sat_sync_log (best-effort, no bloquea el flujo) */
        try {
          await sbUser.from('sat_sync_log').insert({
            org_id: orgId, rfc: cred.rfc, fecha_inicio: fechaIni, fecha_fin: fechaFin,
            tipo, status: 'processing', solicitud_id: idSolicitud,
          });
        } catch (_) { /* el log es opcional */ }
        return json({ ok: true, idSolicitud });
      }

      case 'verificar': {
        const token = await autenticar(efirma);
        const res = await verificarSolicitud(efirma, token, cred.rfc, body.idSolicitud); // ③
        const statusLog = res.estado === 'lista' ? 'completed' : res.estado === 'error' ? 'failed' : 'processing';
        try {
          await sbUser.from('sat_sync_log').update({
            status: statusLog, error_msg: res.estado === 'error' ? res.mensaje : null,
            completed_at: statusLog === 'completed' ? new Date().toISOString() : null,
          }).eq('solicitud_id', body.idSolicitud).eq('org_id', orgId);
        } catch (_) { /* el log es opcional */ }
        return json({ ok: true, ...res });
      }

      case 'descargar': {
        const token = await autenticar(efirma);
        const zipB64 = await descargarPaquete(efirma, token, cred.rfc, body.idPaquete); // ④
        /* Guardar en Supabase (cfdis) además de devolver el ZIP al navegador. */
        let almacen = null;
        try {
          almacen = await guardarCFDIsDeZip(sbUser, orgId, body.tipo || 'recibidos', zipB64);
        } catch (e) { almacen = { error: String(e?.message || e) }; }
        return json({ ok: true, zipB64, almacen });
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

/* ════════════════════════════════════════════════════════════════════════════
   FIRMA FIEL — implementación con node-forge.
   ⚠️ Primera iteración. La canonicalización XML es sensible; probar con la
   acción 'autenticar' contra el SAT e iterar si rechaza la firma.
   ════════════════════════════════════════════════════════════════════════════ */

type Efirma = { cert: any; privateKey: any; certB64: string };

function cargarEfirma(cerB64: string, keyB64: string, pass: string): Efirma {
  // .cer (DER X.509)
  const cerDer = forge.util.decode64(cerB64);
  const cert   = forge.pki.certificateFromAsn1(forge.asn1.fromDer(cerDer));
  // .key de la FIEL (EncryptedPrivateKeyInfo, DER, cifrada con su contraseña)
  const keyDer = forge.util.decode64(keyB64);
  const encPki = forge.asn1.fromDer(keyDer);
  const pkInfo = forge.pki.decryptPrivateKeyInfo(encPki, pass);
  if (!pkInfo) throw new Error('Contraseña de la e.firma incorrecta o .key inválida');
  const privateKey = forge.pki.privateKeyFromAsn1(pkInfo);
  return { cert, privateKey, certB64: cerB64 };
}

function sha1B64(data: string): string {
  const md = forge.md.sha1.create();
  md.update(data, 'utf8');
  return forge.util.encode64(md.digest().bytes());
}
function firmarRSASHA1(data: string, privateKey: any): string {
  const md = forge.md.sha1.create();
  md.update(data, 'utf8');
  return forge.util.encode64(privateKey.sign(md));
}

/* WS-Security namespaces */
const NS_U = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const NS_O = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const VT_X509 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const ET_B64  = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

/* Construye el bloque <Signature> WS-Security firmando el Timestamp (#_0). */
function firmaWSSecurity(ef: Efirma, created: string, expires: string): string {
  // Timestamp canónico (exc-c14n) — namespace u declarado, atributos en orden
  const tsCanon = `<u:Timestamp xmlns:u="${NS_U}" u:Id="_0"><u:Created>${created}</u:Created><u:Expires>${expires}</u:Expires></u:Timestamp>`;
  const digest  = sha1B64(tsCanon);

  // SignedInfo canónico (exc-c14n) — namespace por defecto = xmldsig
  const signedInfo =
    `<SignedInfo xmlns="${NS_DS}">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#_0">` +
    `<Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference></SignedInfo>`;
  const signature = firmarRSASHA1(signedInfo, ef.privateKey);
  const certB64   = ef.certB64.replace(/\s+/g, '');

  return (
    `<o:BinarySecurityToken u:Id="uuid-cert" ValueType="${VT_X509}" EncodingType="${ET_B64}">${certB64}</o:BinarySecurityToken>` +
    `<Signature xmlns="${NS_DS}">${signedInfo}` +
    `<SignatureValue>${signature}</SignatureValue>` +
    `<KeyInfo><o:SecurityTokenReference><o:Reference ValueType="${VT_X509}" URI="#uuid-cert"></o:Reference></o:SecurityTokenReference></KeyInfo>` +
    `</Signature>`
  );
}

async function postSoap(url: string, soap: string, action?: string): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'text/xml;charset=UTF-8' };
  if (action) headers['SOAPAction'] = action;
  const r = await fetch(url, { method: 'POST', headers, body: soap });
  const txt = await r.text();
  if (!r.ok) throw new Error(`SAT ${r.status}: ${txt.slice(0, 300)}`);
  return txt;
}

/* ① Autenticación → token */
async function autenticar(ef: Efirma): Promise<string> {
  const now = new Date();
  const created = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const expires = new Date(now.getTime() + 5 * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const firma = firmaWSSecurity(ef, created, expires);

  const soap =
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="${NS_U}">` +
    `<s:Header><o:Security xmlns:o="${NS_O}" s:mustUnderstand="1">` +
    `<u:Timestamp u:Id="_0"><u:Created>${created}</u:Created><u:Expires>${expires}</u:Expires></u:Timestamp>` +
    firma +
    `</o:Security></s:Header>` +
    `<s:Body><Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"></Autentica></s:Body></s:Envelope>`;

  const resp = await postSoap(SAT.auth, soap, 'http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica');
  const m = resp.match(/<AutenticaResult>([^<]+)<\/AutenticaResult>/);
  if (!m) throw new Error('No se obtuvo token del SAT: ' + resp.slice(0, 300));
  return m[1];
}

const NS_DES = 'http://DescargaMasivaTerceros.sat.gob.mx';

/* Firma ENVELOPED (URI="") sobre el cuerpo de la petición ②③④.
   El nodo a firmar se entrega ya canónico (exc-c14n) y SIN el bloque Signature;
   el digest se calcula sobre ese nodo y la Signature se inyecta dentro de él. */
function firmaEnveloped(ef: Efirma, nodoCanon: string): string {
  const digest = sha1B64(nodoCanon);
  const signedInfo =
    `<SignedInfo xmlns="${NS_DS}">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>` +
    `<Reference URI="">` +
    `<Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference></SignedInfo>`;
  const signature = firmarRSASHA1(signedInfo, ef.privateKey);
  // Datos del certificado para KeyInfo/X509Data
  const issuer = ef.cert.issuer.attributes
    .map((a: any) => `${a.shortName}=${a.value}`).reverse().join(',');
  const serial = ef.cert.serialNumber
    ? BigInt('0x' + ef.cert.serialNumber).toString(10) : '';
  const certB64 = ef.certB64.replace(/\s+/g, '');
  return (
    `<Signature xmlns="${NS_DS}">${signedInfo}` +
    `<SignatureValue>${signature}</SignatureValue>` +
    `<KeyInfo><X509Data>` +
    `<X509IssuerSerial><X509IssuerName>${_xml(issuer)}</X509IssuerName>` +
    `<X509SerialNumber>${serial}</X509SerialNumber></X509IssuerSerial>` +
    `<X509Certificate>${certB64}</X509Certificate>` +
    `</X509Data></KeyInfo></Signature>`
  );
}
function _xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
}

/* ② SolicitaDescarga → IdSolicitud */
async function solicitarDescarga(ef: Efirma, token: string, rfc: string, tipo: string,
  fIni: string, fFin: string): Promise<string> {
  // tipo: 'emitidos' → RfcEmisor=rfc ; 'recibidos' → RfcReceptor=rfc
  const op = tipo === 'emitidos' ? 'SolicitaDescargaEmitidos' : 'SolicitaDescargaRecibidos';
  const fI = `${fIni}T00:00:00`;
  /* FechaFinal no puede estar en el futuro respecto al reloj del SAT (México,
     UTC-6 sin horario de verano). Si el fin solicitado rebasa "ahora" en México,
     se topa a la hora actual. */
  const mexNow = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 19);
  let fF = `${fFin}T23:59:59`;
  if (fF > mexNow) fF = mexNow;
  /* Atributos en ORDEN ALFABÉTICO (C14N). EstadoComprobante usa TEXTO:
     'Vigente' | 'Cancelado' | 'Todos' (NO numérico). La descarga de XML solo
     admite vigentes. El RFC (emisor o receptor) va como ATRIBUTO. */
  const rfcAttr = tipo === 'emitidos' ? `RfcEmisor="${rfc}"` : `RfcReceptor="${rfc}"`;
  const attrs =
    `EstadoComprobante="Vigente" FechaFinal="${fF}" FechaInicial="${fI}" ${rfcAttr} RfcSolicitante="${rfc}" TipoSolicitud="CFDI"`;
  const solicitudCanon = `<des:solicitud xmlns:des="${NS_DES}" ${attrs}></des:solicitud>`;
  const firma = firmaEnveloped(ef, solicitudCanon);

  const soap =
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="${NS_DES}">` +
    `<s:Header/><s:Body><des:${op}><des:solicitud ${attrs}>${firma}</des:solicitud></des:${op}></s:Body></s:Envelope>`;

  const resp = await postSoapAuth(SAT.solicita, soap,
    `http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/${op}`, token);
  const cod = resp.match(/CodEstatus="([^"]+)"/)?.[1];
  const idSol = resp.match(/IdSolicitud="([^"]+)"/)?.[1];
  const msg = resp.match(/Mensaje="([^"]+)"/)?.[1] || '';
  if (!idSol) throw new Error(`SAT solicitud rechazada (${cod || '?'}): ${msg || resp.slice(0, 300)}`);
  return idSol;
}

/* ③ VerificaSolicitudDescarga → estado + IdsPaquetes */
async function verificarSolicitud(ef: Efirma, token: string, rfc: string, idSolicitud: string):
  Promise<{ estado: string; paquetes: string[]; mensaje: string }> {
  const attrs = `IdSolicitud="${idSolicitud}" RfcSolicitante="${rfc}"`;
  const solicitudCanon = `<des:solicitud xmlns:des="${NS_DES}" ${attrs}></des:solicitud>`;
  const firma = firmaEnveloped(ef, solicitudCanon);
  const soap =
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="${NS_DES}">` +
    `<s:Header/><s:Body><des:VerificaSolicitudDescarga><des:solicitud ${attrs}>${firma}</des:solicitud></des:VerificaSolicitudDescarga></s:Body></s:Envelope>`;

  const resp = await postSoapAuth(SAT.verifica, soap,
    'http://DescargaMasivaTerceros.sat.gob.mx/IVerificaSolicitudDescargaService/VerificaSolicitudDescarga', token);
  const estadoSol = resp.match(/EstadoSolicitud="([^"]+)"/)?.[1] || '';   // 1..6
  const codEstatus = resp.match(/CodEstatus="([^"]+)"/)?.[1] || '';
  const mensaje = resp.match(/Mensaje="([^"]+)"/)?.[1] || '';
  const paquetes = [...resp.matchAll(/<(?:\w+:)?IdsPaquetes>([^<]+)<\/(?:\w+:)?IdsPaquetes>/g)].map(m => m[1]);
  // EstadoSolicitud: 1=Aceptada 2=EnProceso 3=Terminada 4=Error 5=Rechazada 6=Vencida
  const mapa: Record<string, string> = { '1':'solicitada','2':'verificando','3':'lista','4':'error','5':'error','6':'error' };
  return { estado: mapa[estadoSol] || 'verificando', paquetes, mensaje: mensaje || `EstadoSolicitud=${estadoSol} (${codEstatus})` };
}

/* ④ Descarga → ZIP base64 */
async function descargarPaquete(ef: Efirma, token: string, rfc: string, idPaquete: string): Promise<string> {
  const attrs = `IdPaquete="${idPaquete}" RfcSolicitante="${rfc}"`;
  const peticionCanon = `<des:peticionDescarga xmlns:des="${NS_DES}" ${attrs}></des:peticionDescarga>`;
  const firma = firmaEnveloped(ef, peticionCanon);
  const soap =
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="${NS_DES}">` +
    `<s:Header/><s:Body><des:PeticionDescargaMasivaTercerosEntrada><des:peticionDescarga ${attrs}>${firma}</des:peticionDescarga></des:PeticionDescargaMasivaTercerosEntrada></s:Body></s:Envelope>`;

  const resp = await postSoapAuth(SAT.descarga, soap,
    'http://DescargaMasivaTerceros.sat.gob.mx/IDescargaMasivaTercerosService/Descargar', token);
  const paquete = resp.match(/<(?:\w+:)?Paquete>([^<]+)<\/(?:\w+:)?Paquete>/)?.[1];
  if (!paquete) {
    const cod = resp.match(/CodEstatus="([^"]+)"/)?.[1];
    const msg = resp.match(/Mensaje="([^"]+)"/)?.[1];
    throw new Error(`SAT descarga sin paquete (${cod || '?'}): ${msg || resp.slice(0, 300)}`);
  }
  return paquete;  // ZIP en base64
}

/* POST SOAP con token en la cabecera Authorization (pasos ②③④) */
async function postSoapAuth(url: string, soap: string, action: string, token: string): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=UTF-8',
      'SOAPAction': action,
      'Authorization': `WRAP access_token="${token}"`,
    },
    body: soap,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`SAT ${r.status}: ${txt.slice(0, 300)}`);
  return txt;
}

/* ════════════════════════════════════════════════════════════════════════════
   PARSEO Y ALMACENAMIENTO DE CFDI (servidor) — guarda en Supabase (cfdis).
   Permite el flujo desatendido (cron) sin pasar por el navegador.
   ════════════════════════════════════════════════════════════════════════════ */

function _attr(xml: string, re: RegExp): string | null {
  const m = xml.match(re);
  return m ? m[1] : null;
}
function _num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Extrae el IVA real del CFDI leyendo los nodos de Impuestos (no aproxima con %).
   IVA = Impuesto "002". Suma el Importe de cada Traslado por su TasaOCuota, y
   las retenciones de IVA. Respeta 16% / 8% (frontera) / 0% / exento. */
function _extraerIVA(xml: string) {
  const r = { iva16: 0, iva8: 0, iva0_base: 0, exento_base: 0, iva_ret: 0 };
  // Traslados de IVA (Impuesto="002"). Capturamos Base, TasaOCuota e Importe.
  const trasRe = /<(?:cfdi:)?Traslado\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = trasRe.exec(xml))) {
    const a = m[1];
    if (!/\bImpuesto="0?0?2"/.test(a) && !/\bImpuesto="002"/.test(a)) continue;
    const tipoFactor = _attr(a, /\bTipoFactor="([^"]+)"/i) || '';
    const tasa  = _num(_attr(a, /\bTasaOCuota="([^"]+)"/i));
    const base  = _num(_attr(a, /\bBase="([^"]+)"/i)) || 0;
    const imp   = _num(_attr(a, /\bImporte="([^"]+)"/i)) || 0;
    if (/exento/i.test(tipoFactor)) { r.exento_base += base; continue; }
    if (tasa === null) continue;
    if (tasa >= 0.15)      r.iva16 += imp;        // 16%
    else if (tasa >= 0.07) r.iva8  += imp;        // 8% frontera
    else                   r.iva0_base += base;   // 0% (base, sin IVA)
  }
  // Retenciones de IVA (Impuesto="002")
  const retRe = /<(?:cfdi:)?Retencion\b([^>]*?)\/?>/gi;
  while ((m = retRe.exec(xml))) {
    const a = m[1];
    if (!/\bImpuesto="0?0?2"/.test(a) && !/\bImpuesto="002"/.test(a)) continue;
    r.iva_ret += _num(_attr(a, /\bImporte="([^"]+)"/i)) || 0;
  }
  return r;
}

/* Extrae los campos clave de un CFDI 3.3/4.0 (regex; suficiente para almacenar). */
function parseCFDI(xml: string): any | null {
  const uuid = _attr(xml, /<(?:tfd:)?TimbreFiscalDigital[^>]*\bUUID="([^"]+)"/i);
  if (!uuid) return null;
  const comp     = xml.match(/<(?:cfdi:)?Comprobante\b([^>]*)>/i)?.[1] ?? '';
  const emisor   = xml.match(/<(?:cfdi:)?Emisor\b([^>]*)\/?>/i)?.[1] ?? '';
  const receptor = xml.match(/<(?:cfdi:)?Receptor\b([^>]*)\/?>/i)?.[1] ?? '';
  const iva = _extraerIVA(xml);
  return {
    uuid,
    version:          _attr(comp, /\bVersion="([^"]+)"/i),
    fecha:            _attr(comp, /\bFecha="([^"]+)"/i),
    serie:            _attr(comp, /\bSerie="([^"]+)"/i),
    folio:            _attr(comp, /\bFolio="([^"]+)"/i),
    subtotal:         _num(_attr(comp, /\bSubTotal="([^"]+)"/i)),
    total:            _num(_attr(comp, /\bTotal="([^"]+)"/i)),
    moneda:           _attr(comp, /\bMoneda="([^"]+)"/i),
    tipo_comprobante: _attr(comp, /\bTipoDeComprobante="([^"]+)"/i),
    forma_pago:       _attr(comp, /\bFormaPago="([^"]+)"/i),
    metodo_pago:      _attr(comp, /\bMetodoPago="([^"]+)"/i),
    rfc_emisor:       _attr(emisor, /\bRfc="([^"]+)"/i),
    nombre_emisor:    _attr(emisor, /\bNombre="([^"]+)"/i),
    rfc_receptor:     _attr(receptor, /\bRfc="([^"]+)"/i),
    nombre_receptor:  _attr(receptor, /\bNombre="([^"]+)"/i),
    iva_16:    iva.iva16, iva_8: iva.iva8, iva_0_base: iva.iva0_base,
    exento_base: iva.exento_base, iva_retenido: iva.iva_ret,
  };
}

/* Descomprime el ZIP (base64), parsea los XML y los UPSERT-ea en cfdis.
   Dedup por (org_id, uuid). Devuelve { total, guardados }. */
async function guardarCFDIsDeZip(client: any, orgId: string, tipo: string, zipB64: string):
  Promise<{ total: number; guardados: number }> {
  const bin = Uint8Array.from(atob(zipB64), c => c.charCodeAt(0));
  const archivos = unzipSync(bin);
  const filas: any[] = [];
  for (const nombre of Object.keys(archivos)) {
    if (!/\.xml$/i.test(nombre)) continue;
    const xml = strFromU8(archivos[nombre]);
    const c = parseCFDI(xml);
    if (!c) continue;
    filas.push({
      org_id: orgId, uuid: c.uuid,
      tipo: tipo === 'emitidos' ? 'emitido' : 'recibido',
      version: c.version, fecha: c.fecha, serie: c.serie, folio: c.folio,
      subtotal: c.subtotal, total: c.total, moneda: c.moneda,
      tipo_comprobante: c.tipo_comprobante, forma_pago: c.forma_pago, metodo_pago: c.metodo_pago,
      rfc_emisor: c.rfc_emisor, nombre_emisor: c.nombre_emisor,
      rfc_receptor: c.rfc_receptor, nombre_receptor: c.nombre_receptor,
      iva_16: c.iva_16, iva_8: c.iva_8, iva_0_base: c.iva_0_base,
      exento_base: c.exento_base, iva_retenido: c.iva_retenido,
      xml,
    });
  }
  let guardados = 0;
  if (filas.length) {
    const { error, count } = await client.from('cfdis')
      .upsert(filas, { onConflict: 'org_id,uuid', count: 'exact' });
    if (error) throw new Error('Guardado cfdis: ' + error.message);
    guardados = count ?? filas.length;
  }
  return { total: filas.length, guardados };
}

/* Carga la e.firma desde una fila de sat_credenciales (descifra en memoria). */
async function cargarEfirmaDeCred(cred: any): Promise<Efirma> {
  if (!cred?.key_encrypted || !cred?.cer_encrypted)
    throw new Error('e.firma incompleta');
  const { iv, cifrado } = JSON.parse(cred.key_encrypted);
  const { keyB64, pass } = JSON.parse(await aesDecrypt(cifrado, iv));
  return cargarEfirma(cred.cer_encrypted, keyB64, pass);
}

/* Rango por defecto: del primer día del mes anterior hasta hoy (fechas YYYY-MM-DD). */
function rangoUltimoMes(): { ini: string; fin: string } {
  const ahoraMx = new Date(Date.now() - 6 * 3600 * 1000);
  const y = ahoraMx.getUTCFullYear(), m = ahoraMx.getUTCMonth();
  const ini = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const fin = ahoraMx.toISOString().slice(0, 10);
  return { ini, fin };
}

/* ════════════════════════════════════════════════════════════════════════════
   CRON — máquina de estados por org+tipo. Pide 1 vez al día y reintenta la
   descarga en cada tick hasta que el SAT entregue el paquete.
   ════════════════════════════════════════════════════════════════════════════ */
async function cronTick(admin: any): Promise<any[]> {
  const { data: creds } = await admin.from('sat_credenciales').select('*').eq('conectado', true);
  const resultados: any[] = [];
  for (const cred of creds || []) {
    let efirma: Efirma;
    try { efirma = await cargarEfirmaDeCred(cred); }
    catch (e) { resultados.push({ org: cred.org_id, error: 'e.firma: ' + String(e?.message || e) }); continue; }
    for (const tipo of ['recibidos', 'emitidos']) {
      try {
        const r = await procesarTipoCron(admin, cred, efirma, tipo);
        resultados.push({ org: cred.org_id, tipo, ...r });
      } catch (e) {
        resultados.push({ org: cred.org_id, tipo, error: String(e?.message || e) });
      }
    }
  }
  return resultados;
}

async function procesarTipoCron(admin: any, cred: any, efirma: Efirma, tipo: string): Promise<any> {
  const orgId = cred.org_id;
  // Última solicitud para este tipo
  const { data: logs } = await admin.from('sat_sync_log')
    .select('*').eq('org_id', orgId).eq('tipo', tipo)
    .order('created_at', { ascending: false }).limit(1);
  const log = logs?.[0];
  const ageH = log ? (Date.now() - new Date(log.created_at).getTime()) / 3600000 : Infinity;

  // En proceso → verificar (o vencer si lleva demasiado)
  if (log && log.status === 'processing') {
    if (ageH > 18) {
      await admin.from('sat_sync_log').update({ status: 'failed', error_msg: 'Vencida (>18h)' }).eq('id', log.id);
      return { accion: 'vencida' };
    }
    const token = await autenticar(efirma);
    const v = await verificarSolicitud(efirma, token, cred.rfc, log.solicitud_id);
    if (v.estado === 'lista') {
      let guardados = 0;
      for (const idPaq of v.paquetes) {
        const t2 = await autenticar(efirma);
        const zip = await descargarPaquete(efirma, t2, cred.rfc, idPaq);
        const r = await guardarCFDIsDeZip(admin, orgId, tipo, zip);
        guardados += r.guardados;
      }
      await admin.from('sat_sync_log').update({
        status: 'completed', completed_at: new Date().toISOString(), cfdi_count: guardados,
      }).eq('id', log.id);
      return { accion: 'descargada', guardados };
    }
    if (v.estado === 'error') {
      await admin.from('sat_sync_log').update({ status: 'failed', error_msg: v.mensaje }).eq('id', log.id);
      return { accion: 'error', msg: v.mensaje };
    }
    return { accion: 'en_proceso' };
  }

  // Completada hace <20h → ya se descargó hoy, no re-solicitar
  if (log && log.status === 'completed' && ageH < 20) return { accion: 'ya_completada_hoy' };
  // Fallida hace <2h → enfriamiento corto antes de reintentar (límites del SAT)
  if (log && log.status === 'failed' && ageH < 2) return { accion: 'fallo_reciente_espera' };

  // Sin solicitud, o fallida (>2h), o completada (>20h) → crear nueva
  const { ini, fin } = rangoUltimoMes();
  const token = await autenticar(efirma);
  const idSol = await solicitarDescarga(efirma, token, cred.rfc, tipo, ini, fin);
  await admin.from('sat_sync_log').insert({
    org_id: orgId, rfc: cred.rfc, fecha_inicio: ini, fecha_fin: fin,
    tipo, status: 'processing', solicitud_id: idSol,
  });
  return { accion: 'solicitada', idSol };
}
