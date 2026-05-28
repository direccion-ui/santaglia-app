/* ═══════════════════════════════════════════════════════════════
   SANTAGLIA COMPASS · Telegram Bot
   Notificaciones proactivas — envío dual (dueño + contador)
   con escalación según días de atraso.
   ═══════════════════════════════════════════════════════════════ */

/* ── Storage keys ── */
const _TG_TOKEN_KEY        = 'stgl_tg_token';
const _TG_CHAT_KEY         = 'stgl_tg_chat_id';       // dueño / usuario admin
const _TG_CHAT2_KEY        = 'stgl_tg_chat_id2';      // contador / receptor secundario
const _TG_CHAT2_LABEL_KEY  = 'stgl_tg_chat2_label';   // ej. "C.P. García"
const _TG_CLIENT_KEY       = 'stgl_tg_client_name';   // ej. "Empresa XYZ S.A."
const _TG_PREFS_KEY        = 'stgl_tg_prefs';
const _TG_SENT_KEY         = 'stgl_tg_sent';          // anti-spam: { "tipo_mes": timestamp }

/* Cooldown: 8 h → máximo ~2 alertas por día por tipo */
const _TG_COOLDOWN = 8 * 60 * 60 * 1000;

/* ── Preferencias por defecto ── */
const _TG_PREFS_DEFAULT = {
  retenciones : true,
  sat_opinion : true,
  cfdi_pend   : false,
  resumen     : false
};

/* ═══════════════════════════════════════════════════════════════
   CONFIG — getters / setters
   ═══════════════════════════════════════════════════════════════ */
function tg_getConfig() {
  return {
    token      : localStorage.getItem(_TG_TOKEN_KEY)       || '',
    chatId     : localStorage.getItem(_TG_CHAT_KEY)        || '',
    chatId2    : localStorage.getItem(_TG_CHAT2_KEY)       || '',
    chat2Label : localStorage.getItem(_TG_CHAT2_LABEL_KEY) || 'Contador',
    clientName : localStorage.getItem(_TG_CLIENT_KEY)      || '',
    prefs      : JSON.parse(localStorage.getItem(_TG_PREFS_KEY) || 'null') || { ..._TG_PREFS_DEFAULT }
  };
}

function tg_isConfigured() {
  const { token, chatId } = tg_getConfig();
  return token.length > 20 && chatId.length >= 5;
}

function tg_saveConfig(token, chatId, chatId2, clientName, chat2Label) {
  localStorage.setItem(_TG_TOKEN_KEY, (token      || '').trim());
  localStorage.setItem(_TG_CHAT_KEY,  (chatId     || '').trim());
  if (chatId2    !== undefined) localStorage.setItem(_TG_CHAT2_KEY,      (chatId2    || '').trim());
  if (clientName !== undefined) localStorage.setItem(_TG_CLIENT_KEY,     (clientName || '').trim());
  if (chat2Label !== undefined) localStorage.setItem(_TG_CHAT2_LABEL_KEY,(chat2Label || '').trim());
}

function tg_savePrefs(prefs) {
  localStorage.setItem(_TG_PREFS_KEY, JSON.stringify(prefs));
}

/* ═══════════════════════════════════════════════════════════════
   ENVÍO — fetch directo a la API de Telegram
   ═══════════════════════════════════════════════════════════════ */

/** Envía texto a un chatId específico usando el token configurado */
async function tg_sendTo(chatId, text) {
  const { token } = tg_getConfig();
  if (!token || !chatId) return { ok: false, error: 'Sin configurar' };
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      }
    );
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Envía al chatId del dueño/admin */
async function tg_send(text) {
  const { chatId } = tg_getConfig();
  return tg_sendTo(chatId, text);
}

/* ── Test de conexión ── */
async function tg_test() {
  const fecha = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  const { chatId2, chat2Label, clientName } = tg_getConfig();

  const msgDueño =
    `✅ <b>Santaglia Compass conectado</b>\n\n` +
    `Recibirás alertas proactivas sobre:\n` +
    `  • Retenciones por vencer (día 17)\n` +
    `  • Pagos vencidos con nivel de urgencia\n` +
    `  • Diferencias entre lo retenido y pagado\n\n` +
    `<i>Compass · ${fecha}</i>`;

  const r1 = await tg_send(msgDueño);

  if (chatId2) {
    await tg_sendTo(chatId2,
      `📋 <b>Notificaciones Compass activadas</b>\n\n` +
      `Recibirás alertas de cumplimiento SAT` +
      (clientName ? ` de <b>${clientName}</b>` : '') + `.\n` +
      `Las notificaciones llegarán automáticamente cuando haya pagos próximos o vencidos.\n\n` +
      `<i>Compass · ${fecha}</i>`
    );
  }

  return r1;
}

/* ═══════════════════════════════════════════════════════════════
   ANTI-SPAM — cooldown de 8 h por clave de alerta
   ═══════════════════════════════════════════════════════════════ */
function _tg_canSend(key) {
  try {
    const sent = JSON.parse(localStorage.getItem(_TG_SENT_KEY) || '{}');
    return (Date.now() - (sent[key] || 0)) > _TG_COOLDOWN;
  } catch { return true; }
}

function _tg_markSent(key) {
  try {
    const sent = JSON.parse(localStorage.getItem(_TG_SENT_KEY) || '{}');
    sent[key] = Date.now();
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const k in sent) if (sent[k] < cutoff) delete sent[k];
    localStorage.setItem(_TG_SENT_KEY, JSON.stringify(sent));
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════
   ESCALACIÓN — tono y urgencia según días de atraso
   ═══════════════════════════════════════════════════════════════ */
const _fmt = n => Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });

function _tg_escalIcon(dias) {
  if (dias >= 15) return '🚨';
  if (dias >= 8)  return '🔴';
  return '⚠️';
}

function _tg_escalTitulo(dias) {
  if (dias >= 15) return 'CRÍTICO';
  if (dias >= 8)  return 'URGENTE';
  return 'Pendiente';
}

/** Texto de recomendación para el dueño según urgencia */
function _tg_recomendacionDueño(dias) {
  if (dias >= 15)
    return `\n\n🚨 <b>Acción inmediata:</b> Con ${dias} días de atraso se acumulan recargos y pueden generarse multas por el SAT. Contacta a tu contador <b>hoy mismo</b> para regularizar antes de que la situación escale.`;
  if (dias >= 8)
    return `\n\n⚠️ <b>Recomendación:</b> Superas los 8 días de atraso. Los recargos crecen cada día. Comunícate con tu contador a la brevedad para gestionar el pago y obtener las líneas de captura.`;
  if (dias >= 4)
    return `\n\n💡 Confirma con tu contador que las líneas de captura ya fueron enviadas y que el pago está programado.`;
  return '';
}

/** Texto de presión para el contador según urgencia */
function _tg_textoContador(mesNom, totalRet, diasAtraso, clientName, titulo) {
  const recar = (diasAtraso * 0.00192 * 100).toFixed(2);
  const icon  = _tg_escalIcon(diasAtraso);

  let urgencia = '';
  if (diasAtraso >= 15)
    urgencia = `\n\n🚨 <b>ACCIÓN INMEDIATA:</b> Tu cliente acumula recargos y posibles multas. Envía las líneas de captura HOY y coordina el pago.`;
  else if (diasAtraso >= 8)
    urgencia = `\n\n⚡ Envía las líneas de captura a tu cliente a la brevedad. Cada día adicional genera más recargos.`;
  else
    urgencia = `\n\n⚡ Envía las líneas de captura a tu cliente para evitar atrasos adicionales.`;

  return (
    `${icon} <b>[${titulo}] ${clientName || 'Tu cliente'} — Retención ${mesNom}</b>\n\n` +
    `Monto pendiente: <b>$${_fmt(totalRet)} MXN</b>\n` +
    `Días de atraso: <b>${diasAtraso}d</b> · Recargos est. ~${recar}%` +
    urgencia
  );
}

/* ═══════════════════════════════════════════════════════════════
   ALERTAS TIPADAS — envío dual con escalación
   ═══════════════════════════════════════════════════════════════ */

/* Retención vencida ─────────────────────────────────────────── */
async function tg_alertaRetencionVencida(mesNom, totalRet, diasAtraso) {
  const { prefs, chatId2, clientName } = tg_getConfig();
  if (!prefs.retenciones || !tg_isConfigured()) return;
  const key = `ret_vencida_${mesNom}`;
  if (!_tg_canSend(key)) return;

  const icon   = _tg_escalIcon(diasAtraso);
  const titulo = _tg_escalTitulo(diasAtraso);
  const recar  = (diasAtraso * 0.00192 * 100).toFixed(2);

  // Mensaje al dueño
  const r1 = await tg_send(
    `${icon} <b>Retención vencida — ${mesNom}</b>\n\n` +
    `Monto: <b>$${_fmt(totalRet)} MXN</b>\n` +
    `Atraso: <b>${diasAtraso} día${diasAtraso !== 1 ? 's' : ''}</b>\n` +
    `Recargos est.: ~${recar}% sobre el monto` +
    _tg_recomendacionDueño(diasAtraso) +
    `\n\n<i>Compass → Retenciones para registrar el pago</i>`
  );

  // Mensaje al contador (si configurado)
  if (chatId2) {
    await tg_sendTo(chatId2, _tg_textoContador(mesNom, totalRet, diasAtraso, clientName, titulo));
  }

  if (r1.ok) _tg_markSent(key);
  return r1;
}

/* Retención próxima a vencer ──────────────────────────────── */
async function tg_alertaRetencionProxima(mesNom, totalRet, diasRestantes, fechaLimite) {
  const { prefs, chatId2, clientName } = tg_getConfig();
  if (!prefs.retenciones || !tg_isConfigured()) return;
  const key = `ret_proxima_${mesNom}`;
  if (!_tg_canSend(key)) return;

  const r1 = await tg_send(
    `⚡ <b>Retención por vencer — ${mesNom}</b>\n\n` +
    `Monto a pagar: <b>$${_fmt(totalRet)} MXN</b>\n` +
    `Fecha límite SAT: <b>${fechaLimite}</b>\n` +
    `Faltan: <b>${diasRestantes} día${diasRestantes !== 1 ? 's' : ''}</b>\n\n` +
    `💡 Verifica con tu contador que las líneas de captura estén listas.\n` +
    `<i>Compass → Retenciones</i>`
  );

  if (chatId2) {
    await tg_sendTo(chatId2,
      `⚡ <b>${clientName || 'Tu cliente'} — Retención vence en ${diasRestantes}d</b>\n\n` +
      `Monto: <b>$${_fmt(totalRet)} MXN</b>\n` +
      `Límite SAT: <b>${fechaLimite}</b>\n\n` +
      `Prepara las líneas de captura y envíalas al cliente antes del vencimiento.`
    );
  }

  if (r1.ok) _tg_markSent(key);
  return r1;
}

/* Diferencia retenido vs pagado ─────────────────────────────── */
async function tg_alertaDiferenciaRetencion(mesNom, retenido, pagado, diff) {
  const { prefs } = tg_getConfig();
  if (!prefs.retenciones || !tg_isConfigured()) return;
  const key = `ret_diff_${mesNom}`;
  if (!_tg_canSend(key)) return;

  const tipo = diff > 0 ? '⚠️ Posible pago insuficiente' : '🔵 Pago excedente detectado';
  const res = await tg_send(
    `${tipo} — <b>${mesNom}</b>\n\n` +
    `Retenido: $${_fmt(retenido)}\n` +
    `Pagado:   $${_fmt(pagado)}\n` +
    `Diferencia: <b>$${_fmt(Math.abs(diff))}</b>\n\n` +
    `Verifica los acuses SAT en Compass → Retenciones.`
  );
  if (res.ok) _tg_markSent(key);
  return res;
}

/* IVA de honorarios faltante ─────────────────────────────────── */
async function tg_alertaIvaFaltante(mesNom, isrHon) {
  const { prefs } = tg_getConfig();
  if (!prefs.retenciones || !tg_isConfigured()) return;
  const key = `ret_iva_${mesNom}`;
  if (!_tg_canSend(key)) return;

  const res = await tg_send(
    `⚠️ <b>IVA de honorarios no registrado — ${mesNom}</b>\n\n` +
    `Hay ISR honorarios ($${_fmt(isrHon)}) sin IVA retenido.\n` +
    `Verifica que los CFDIs de honorarios incluyan retención de IVA.\n\n` +
    `Abre Compass → Retenciones para corregirlo.`
  );
  if (res.ok) _tg_markSent(key);
  return res;
}

/* Pago extemporáneo ─────────────────────────────────────────── */
async function tg_alertaPagoTardio(mesNom, diasAtraso, fechaPago, fechaLimite) {
  const { prefs } = tg_getConfig();
  if (!prefs.retenciones || !tg_isConfigured()) return;
  const key = `ret_tardio_${mesNom}`;
  if (!_tg_canSend(key)) return;

  const res = await tg_send(
    `🔶 <b>Pago extemporáneo — ${mesNom}</b>\n\n` +
    `Límite SAT: ${fechaLimite}\n` +
    `Fecha de pago: ${fechaPago}\n` +
    `Días de atraso: <b>${diasAtraso}</b>\n\n` +
    `Pueden existir recargos y actualización no reflejados en los acuses.`
  );
  if (res.ok) _tg_markSent(key);
  return res;
}

/* ═══════════════════════════════════════════════════════════════
   DESPACHAR anomalías desde un array (output de detectarAnomalias)
   ═══════════════════════════════════════════════════════════════ */
async function tg_despacharAnomalias(row, anomalias) {
  if (!tg_isConfigured() || !anomalias.length) return;
  const { m, totalRet, totalPag, diff, fechaPago } = row;
  const MES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const mesNom = `${MES[m - 1]} ${new Date().getFullYear()}`;

  for (const a of anomalias) {
    switch (a.tipo) {
      case 'vencido':
        await tg_alertaRetencionVencida(mesNom, totalRet, row.venc.diasAtraso);
        break;
      case 'proximo':
        await tg_alertaRetencionProxima(mesNom, totalRet, row.venc.diasRestantes, row.venc.limite);
        break;
      case 'underpaid':
      case 'overpaid':
        await tg_alertaDiferenciaRetencion(mesNom, totalRet, totalPag, diff);
        break;
      case 'iva-faltante':
        await tg_alertaIvaFaltante(mesNom, row.isrHonR);
        break;
      case 'tardio':
        if (fechaPago) {
          const d = Math.round(
            (new Date(fechaPago + 'T00:00:00') - new Date(row.venc.limite + 'T00:00:00')) / 86400000
          );
          await tg_alertaPagoTardio(mesNom, d, fechaPago, row.venc.limite);
        }
        break;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   SYNC A IndexedDB — para que el Service Worker pueda leer
   los datos de anomalías aunque Compass esté cerrado
   ═══════════════════════════════════════════════════════════════ */
async function tg_syncToIDB(anomaliasData) {
  if (!window.indexedDB) return;
  try {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('compass-sw', 1);
      req.onupgradeneeded = e =>
        e.target.result.createObjectStore('notif-data', { keyPath: 'id' });
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    const cfg = tg_getConfig();
    const payload = {
      id        : 'compass-notif',
      token     : cfg.token,
      chatId    : cfg.chatId,
      chatId2   : cfg.chatId2,
      chat2Label: cfg.chat2Label,
      clientName: cfg.clientName,
      prefs     : cfg.prefs,
      anomalias : anomaliasData,
      updatedAt : Date.now()
    };
    await new Promise((res, rej) => {
      const tx = db.transaction('notif-data', 'readwrite');
      tx.objectStore('notif-data').put(payload);
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  } catch(e) {
    console.warn('[Compass] IDB sync error:', e.message);
  }
}
