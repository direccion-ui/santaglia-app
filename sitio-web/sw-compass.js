/* ═══════════════════════════════════════════════════════════════
   SANTAGLIA COMPASS · Service Worker
   Notificaciones proactivas vía Telegram — corre en background
   incluso cuando Compass está cerrado.

   Compatibilidad:
     • Chrome / Edge / Android Chrome — Periodic Background Sync ✓
     • Firefox / Safari — fallback: envía al abrir retenciones.html
   ═══════════════════════════════════════════════════════════════ */

const SW_VERSION = '1.1.0';
const IDB_NAME   = 'compass-sw';
const IDB_VER    = 1;
const STORE      = 'notif-data';

/* ── IndexedDB helpers ── */
function _openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e =>
      e.target.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function _idbGet(key) {
  const db = await _openIDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = e => res(e.target.result);   // returns full record (id + fields)
    req.onerror   = e => rej(e.target.error);
  });
}

async function _idbPut(record) {
  const db = await _openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = res;
    tx.onerror    = e => rej(e.target.error);
  });
}

/* ── Anti-spam — IDB-based, 8 h por clave ── */
async function _canSend(sentMap, key) {
  return (Date.now() - (sentMap[key] || 0)) > 8 * 3600 * 1000;
}

/* ── Telegram fetch directo ── */
async function _tgSend(token, chatId, text) {
  if (!token || !chatId || !text) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch(e) {
    console.warn('[Compass SW] Telegram send error:', e.message);
  }
}

/* ── Formateo numérico ── */
const _fmtSW = n =>
  Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });

/* ── Escalación ── */
function _icon(dias)  { return dias >= 15 ? '🚨' : dias >= 8 ? '🔴' : '⚠️'; }
function _titulo(dias){ return dias >= 15 ? 'CRÍTICO' : dias >= 8 ? 'URGENTE' : 'Pendiente'; }

function _recomDueño(dias) {
  if (dias >= 15)
    return `\n\n🚨 <b>Acción inmediata:</b> Con ${dias} días de atraso se acumulan recargos y pueden generarse multas. Contacta a tu contador <b>hoy</b> para regularizar.`;
  if (dias >= 8)
    return `\n\n⚠️ <b>Recomendación:</b> Superas los 8 días de atraso — los recargos crecen cada día. Comunícate con tu contador para gestionar el pago.`;
  if (dias >= 4)
    return `\n\n💡 Confirma con tu contador que las líneas de captura ya fueron enviadas.`;
  return '';
}

function _msgContador(mesNom, totalRet, diasAtraso, clientName, titulo) {
  const recar = (diasAtraso * 0.00192 * 100).toFixed(2);
  const icon  = _icon(diasAtraso);
  let urgencia = diasAtraso >= 15
    ? `\n\n🚨 <b>ACCIÓN INMEDIATA:</b> Tu cliente acumula recargos y posibles multas. Envía las líneas de captura HOY.`
    : diasAtraso >= 8
      ? `\n\n⚡ Envía las líneas de captura al cliente a la brevedad — cada día adicional genera más recargos.`
      : `\n\n⚡ Envía las líneas de captura al cliente para evitar atrasos adicionales.`;
  return (
    `${icon} <b>[${titulo}] ${clientName || 'Tu cliente'} — Retención ${mesNom}</b>\n\n` +
    `Monto pendiente: <b>$${_fmtSW(totalRet)} MXN</b>\n` +
    `Días de atraso: <b>${diasAtraso}d</b> · Recargos est. ~${recar}%` +
    urgencia
  );
}

/* ═══════════════════════════════════════════════════════════════
   CORE — lee IDB y despacha alertas
   ═══════════════════════════════════════════════════════════════ */
async function _checkAndNotify() {
  let record;
  try { record = await _idbGet('compass-notif'); } catch { return; }
  if (!record) return;

  const { token, chatId, chatId2, clientName, prefs, anomalias } = record;
  if (!token || !chatId) return;
  if (!prefs?.retenciones) return;
  if (!anomalias || !anomalias.length) return;

  /* Leer mapa de anti-spam */
  let sentRecord;
  try { sentRecord = await _idbGet('compass-sent'); } catch {}
  const sentMap = sentRecord?.map || {};
  const sentDirty = {};

  for (const item of anomalias) {
    const { mesNom, tipo, totalRet, diasAtraso, diasRestantes, fechaLimite } = item;

    if (tipo === 'vencido') {
      const key = `ret_vencida_${mesNom}`;
      if (!(await _canSend(sentMap, key))) continue;

      const icon  = _icon(diasAtraso);
      const titulo= _titulo(diasAtraso);
      const recar = (diasAtraso * 0.00192 * 100).toFixed(2);

      await _tgSend(token, chatId,
        `${icon} <b>Retención vencida — ${mesNom}</b>\n\n` +
        `Monto: <b>$${_fmtSW(totalRet)} MXN</b>\n` +
        `Atraso: <b>${diasAtraso} día${diasAtraso !== 1 ? 's' : ''}</b>\n` +
        `Recargos est.: ~${recar}%` +
        _recomDueño(diasAtraso) +
        `\n\n<i>Compass → Retenciones</i>`
      );

      if (chatId2) {
        await _tgSend(token, chatId2,
          _msgContador(mesNom, totalRet, diasAtraso, clientName, titulo)
        );
      }
      sentDirty[key] = Date.now();

    } else if (tipo === 'proximo') {
      const key = `ret_proxima_${mesNom}`;
      if (!(await _canSend(sentMap, key))) continue;

      await _tgSend(token, chatId,
        `⚡ <b>Retención por vencer — ${mesNom}</b>\n\n` +
        `Monto: <b>$${_fmtSW(totalRet)} MXN</b>\n` +
        `Límite SAT: <b>${fechaLimite}</b>\n` +
        `Faltan: <b>${diasRestantes} día${diasRestantes !== 1 ? 's' : ''}</b>\n\n` +
        `💡 Verifica con tu contador que las líneas de captura estén listas.\n` +
        `<i>Compass → Retenciones</i>`
      );

      if (chatId2) {
        await _tgSend(token, chatId2,
          `⚡ <b>${clientName || 'Tu cliente'} — Retención vence en ${diasRestantes}d</b>\n\n` +
          `Monto: <b>$${_fmtSW(totalRet)} MXN</b> · Límite: <b>${fechaLimite}</b>\n\n` +
          `Prepara y envía las líneas de captura al cliente antes del vencimiento.`
        );
      }
      sentDirty[key] = Date.now();
    }
    /* otros tipos (diff, iva-faltante, tardio) — solo al dueño, sin escalación */
  }

  /* Persistir timestamps de anti-spam */
  if (Object.keys(sentDirty).length) {
    const newMap = { ...sentMap, ...sentDirty };
    // Purgar entradas > 7 días
    const cutoff = Date.now() - 7 * 86400 * 1000;
    for (const k in newMap) if (newMap[k] < cutoff) delete newMap[k];
    try {
      await _idbPut({ id: 'compass-sent', map: newMap });
    } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER EVENTS
   ═══════════════════════════════════════════════════════════════ */

/* Install: activa inmediatamente sin esperar a cerrar otras tabs */
self.addEventListener('install', e => {
  console.log('[Compass SW] Install v' + SW_VERSION);
  self.skipWaiting();
});

/* Activate: toma control de todas las páginas abiertas */
self.addEventListener('activate', e => {
  console.log('[Compass SW] Activate');
  e.waitUntil(self.clients.claim());
});

/* Periodic Background Sync — Chrome/Edge */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'stgl-notif') {
    console.log('[Compass SW] Periodic sync fired');
    event.waitUntil(_checkAndNotify());
  }
});

/* Message desde la página — actualizar datos o forzar check */
self.addEventListener('message', event => {
  if (!event.data) return;

  if (event.data.type === 'NOTIF_DATA') {
    /* La página actualizó los datos de anomalías */
    _idbPut({ id: 'compass-notif', ...event.data.payload })
      .catch(e => console.warn('[Compass SW] IDB write error:', e));
  }

  if (event.data.type === 'FORCE_CHECK') {
    /* El usuario solicitó check inmediato (ej. al abrir retenciones.html) */
    _checkAndNotify().catch(console.warn);
  }
});
