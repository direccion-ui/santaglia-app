/* ─── SANTAGLIA · App utilities ─── */

/* ══════════════════════════════════════════════════════════════
   STGL PERSIST — Capa de persistencia en 3 niveles:
   1. localStorage  (lectura/escritura inmediata, UI rápida)
   2. IndexedDB     (respaldo local, sobrevive reinicios Safari)
   3. Supabase      (nube, fuente de verdad definitiva)
   ══════════════════════════════════════════════════════════════ */

/* ── Configuración Supabase ── */
const _SB_URL   = 'https://vblazgxsyidxttobiszt.supabase.co';
const _SB_KEY   = 'sb_publishable_T6iu_Tk9mxxXdBMngfqE8A_hPCH4cXA';
let _sbClient   = null;
let _sbReady    = false;

/* Contexto de sesión del usuario activo */
let _stglOrgId    = null;
let _stglUserRole = null;
let _stglUserName = null;

function _getOrgId() {
  // 1) En-memory (set by _loadUserContext after Supabase auth)
  if (_stglOrgId) return _stglOrgId;
  // 2) sessionStorage (persiste mientras la pestaña esté abierta)
  const ss = sessionStorage.getItem('stgl_org_id');
  if (ss) return ss;
  // 3) localStorage (persiste entre sesiones — fuente de verdad local)
  const ls = localStorage.getItem('stgl_org_id');
  if (ls) return ls;
  // 4) Derivar desde el RFC de la empresa (stgl_config) o generar UUID
  try {
    const cfg = JSON.parse(localStorage.getItem('stgl_config') || '{}');
    const rfc = cfg.empresa?.rfc || cfg.empresa?.RFC || '';
    const id  = rfc
      ? 'local-' + rfc.toUpperCase().replace(/[^A-Z0-9]/g, '')
      : 'local-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('stgl_org_id', id);
    sessionStorage.setItem('stgl_org_id', id);
    return id;
  } catch {
    return null;
  }
}
function _getUserRole() { return _stglUserRole || sessionStorage.getItem('stgl_user_role'); }
function _getUserName() { return _stglUserName || sessionStorage.getItem('stgl_user_name'); }

/* Carga el SDK de Supabase vía CDN y devuelve el cliente */
function _initSupabase() {
  if (_sbClient) return Promise.resolve(_sbClient);
  return new Promise((res, rej) => {
    if (window.supabase) {
      _sbClient = window.supabase.createClient(_SB_URL, _SB_KEY);
      _sbReady  = true;
      return res(_sbClient);
    }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = () => {
      _sbClient = window.supabase.createClient(_SB_URL, _SB_KEY);
      _sbReady  = true;
      res(_sbClient);
    };
    s.onerror = () => rej(new Error('No se pudo cargar Supabase SDK'));
    document.head.appendChild(s);
  });
}

/* ══════════════════════════════════════════════════════════════
   Supabase KV — Fase 4 activa
   Tabla: stgl_data (org_id TEXT, key TEXT, value TEXT, updated_at TIMESTAMPTZ)
   ══════════════════════════════════════════════════════════════ */

/* Write-through: escribe una clave en Supabase (fire-and-forget) */
function _sbWrite(key, value) {
  _initSupabase().then(sb => {
    const orgId = _getOrgId();
    if (!orgId || orgId.startsWith('local-')) return; // sin sesión real, silencio
    sb.from('stgl_data')
      .upsert({ org_id: orgId, key, value, updated_at: new Date().toISOString() },
               { onConflict: 'org_id,key' })
      .then(() => {}).catch(() => {});
  }).catch(() => {});
}

/* Lee todas las claves de la org desde Supabase */
async function _sbReadAll() {
  try {
    const sb    = await _initSupabase();
    const orgId = _getOrgId();
    if (!orgId) return [];
    const { data, error } = await sb
      .from('stgl_data')
      .select('key, value')
      .eq('org_id', orgId);
    if (error) { console.warn('[stgl] _sbReadAll error:', error.message); return []; }
    return data || [];
  } catch(e) { console.warn('[stgl] _sbReadAll exception:', e); return []; }
}

/* Snapshot completo: vuelca todo localStorage → Supabase */
async function _sbSnapshot() {
  try {
    const sb    = await _initSupabase();
    const orgId = _getOrgId();
    if (!orgId || orgId.startsWith('local-')) return;
    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('stgl_'))
        rows.push({ org_id: orgId, key: k, value: localStorage.getItem(k),
                    updated_at: new Date().toISOString() });
    }
    if (!rows.length) return;
    // Intentar bulk upsert; si falla, escribir fila por fila
    const { error } = await sb.from('stgl_data')
      .upsert(rows, { onConflict: 'org_id,key' });
    if (error) {
      console.warn('[stgl] bulk upsert falló, reintentando fila por fila:', error.message);
      for (const row of rows) {
        const rowResult = await sb.from('stgl_data').upsert(row, { onConflict: 'org_id,key' });
        if (rowResult.error) console.warn('[stgl] row upsert error:', row.key, rowResult.error);
      }
    }
  } catch(e) { console.warn('[stgl] _sbSnapshot exception:', e); }
}

/* ══════════════════════════════════════════════════════════════
   IndexedDB — respaldo local (nivel 2)
   ══════════════════════════════════════════════════════════════ */
const _STGL_DB_NAME = 'stgl_persist';
const _STGL_DB_VER  = 1;
const _STGL_STORE   = 'kv';
const _STGL_TS_KEY  = '__stgl_snapshot_ts';
let   _stglDb       = null;

function _openPersistDB() {
  if (_stglDb) return Promise.resolve(_stglDb);
  return new Promise((res, rej) => {
    const req = indexedDB.open(_STGL_DB_NAME, _STGL_DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_STGL_STORE);
    req.onsuccess  = e => { _stglDb = e.target.result; res(_stglDb); };
    req.onerror    = ()  => rej(req.error);
    req.onblocked  = ()  => rej(new Error('IDB bloqueado'));
  });
}

function _idbWrite(key, value) {
  _openPersistDB().then(db => {
    const tx = db.transaction(_STGL_STORE, 'readwrite');
    tx.objectStore(_STGL_STORE).put(value, key);
  }).catch(() => {});
}

function _idbReadAll() {
  return _openPersistDB().then(db => new Promise(res => {
    const out = {};
    const req = db.transaction(_STGL_STORE, 'readonly')
                  .objectStore(_STGL_STORE).openCursor();
    req.onsuccess = e => {
      const cur = e.target.result;
      if (cur) { out[cur.key] = cur.value; cur.continue(); }
      else res(out);
    };
    req.onerror = () => res({});
  })).catch(() => ({}));
}

/* Snapshot completo a IndexedDB */
function _idbSnapshot() {
  _openPersistDB().then(db => {
    const tx    = db.transaction(_STGL_STORE, 'readwrite');
    const store = tx.objectStore(_STGL_STORE);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('stgl_')) store.put(localStorage.getItem(k), k);
    }
    store.put(String(Date.now()), _STGL_TS_KEY);
  }).catch(() => {});
}

/* ══════════════════════════════════════════════════════════════
   Interceptor localStorage — escribe en los 3 niveles
   ══════════════════════════════════════════════════════════════ */
(function _interceptLocalStorage() {
  const _orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    _orig(key, value);
    if (typeof key === 'string' && key.startsWith('stgl_')) {
      _idbWrite(key, value);   // nivel 2: IndexedDB local
      _sbWrite(key, value);    // nivel 3: Supabase nube
    }
  };
})();

/* ══════════════════════════════════════════════════════════════
   Restauración al arrancar — cascada: localStorage → IDB → Supabase
   ══════════════════════════════════════════════════════════════ */
async function _checkAndRestore() {
  // stgl_supabase_migrated es la señal de que los datos ya están cargados/sincronizados.
  // Si existe en localStorage, no hay nada que restaurar.
  if (localStorage.getItem('stgl_supabase_migrated')) return;

  // Intento 1: IndexedDB — solo si IDB también tiene la señal de sync válida
  const idb = await _idbReadAll();
  if (idb['stgl_supabase_migrated']) {
    const entries = Object.entries(idb).filter(([k]) => k.startsWith('stgl_'));
    entries.forEach(([k, v]) => { if (v != null) localStorage.setItem(k, v); });
    const ts = idb[_STGL_TS_KEY] ? new Date(+idb[_STGL_TS_KEY]).toLocaleString('es-MX') : '—';
    try { toast(`✅ Datos restaurados desde respaldo local (${ts}). Recargando…`, 'success'); } catch {}
    setTimeout(() => location.reload(), 2000);
    return;
  }

  // Intento 2: Supabase — usar session.user.id directamente
  try {
    const sb = await _initSupabase();
    const { data: authData } = await sb.auth.getSession();
    const session = authData?.session;
    if (!session) return;
    const orgId = session.user.id;
    const { data, error } = await sb
      .from('stgl_data').select('key, value').eq('org_id', orgId);
    if (error) { console.warn('[stgl] restore error:', error.message); return; }
    const stglRows = (data || []).filter(r => r.key?.startsWith('stgl_'));
    if (!stglRows.length) return;
    _stglOrgId = orgId;
    stglRows.forEach(({ key, value }) => { if (value != null) localStorage.setItem(key, value); });
    stglRows.forEach(({ key, value }) => _idbWrite(key, value));
    console.log(`[stgl] Restaurados ${stglRows.length} bloques desde Supabase. Recargando…`);
    try { toast(`☁️ Datos restaurados desde la nube (${stglRows.length} bloques). Recargando…`, 'success'); } catch {}
    // Usar location.replace para garantizar el reload en mobile Safari
    // (setTimeout solo no siempre dispara en contexto post-login mobile)
    const reloadUrl = location.href.split('?')[0];
    setTimeout(() => { location.replace(reloadUrl); }, 1500);
  } catch(e) { console.warn('[stgl] _checkAndRestore exception:', e); }
}

/* ══════════════════════════════════════════════════════════════
   _loadUserContext — carga org_id + rol después del login
   ══════════════════════════════════════════════════════════════ */
async function _loadUserContext() {
  try {
    const sb = await _initSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;

    // Cargar perfil + org actual
    const { data: profile } = await sb
      .from('profiles')
      .select('nombre, current_org_id')
      .eq('id', session.user.id)
      .single();

    if (profile?.current_org_id) {
      // Cargar rol en la org actual
      const { data: membership } = await sb
        .from('user_org')
        .select('rol')
        .eq('user_id', session.user.id)
        .eq('org_id', profile.current_org_id)
        .single();

      _stglOrgId    = profile.current_org_id;
      _stglUserRole = membership?.rol || 'owner';
      _stglUserName = profile.nombre || session.user.email;
      // Guardar en ambos storage para sobrevivir recargas
      const _lsOrig = localStorage.setItem.bind(localStorage);
      _lsOrig('stgl_org_id', _stglOrgId);   // localStorage sin interceptor
      sessionStorage.setItem('stgl_org_id',    _stglOrgId);
      sessionStorage.setItem('stgl_user_role', _stglUserRole);
      sessionStorage.setItem('stgl_user_name', _stglUserName);
      // Actualizar badge ahora que tenemos org_id real de Supabase
      _actualizarEstadoSync();
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   _applyRoleUI — oculta controles según el rol del usuario
   ══════════════════════════════════════════════════════════════ */
function _applyRoleUI(role) {
  if (!role || role === 'owner' || role === 'admin') return; // acceso completo

  if (role === 'despacho') {
    // Ocultar acciones destructivas y configuración
    [
      'a[href="configuracion.html"]',
      '.nav-menu-item[href="configuracion.html"]',
      '#btn-limpiar', '#btn-reset', '.btn-reset',
    ].forEach(sel => document.querySelectorAll(sel).forEach(el => el.style.display = 'none'));

    // Badge "Modo Despacho" en esquina inferior
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:0.75rem;left:50%;transform:translateX(-50%);' +
      'background:var(--navy);color:#fff;font-size:0.6rem;padding:0.2rem 0.8rem;' +
      'border-radius:20px;opacity:0.55;font-family:var(--brand);letter-spacing:0.08em;' +
      'pointer-events:none;z-index:9999;';
    badge.textContent = 'MODO DESPACHO — solo lectura';
    document.body.appendChild(badge);
  }
}

/* ══════════════════════════════════════════════════════════════
   _injectUserBadge — muestra nombre + rol en la barra de nav
   ══════════════════════════════════════════════════════════════ */
function _injectUserBadge(name, role) {
  const btn = document.querySelector('.btn-logout');
  if (!btn || !name) return;
  const roleLabel = { owner: 'Director', admin: 'Admin', member: 'Usuario', despacho: 'Despacho' }[role] || role;
  const badge = document.createElement('span');
  badge.style.cssText = 'font-size:0.62rem;color:var(--text-dim);margin-right:0.75rem;' +
    'font-family:var(--brand);font-weight:600;white-space:nowrap;';
  // Mostrar solo el primer nombre para no saturar el nav
  const firstName = name.split(' ')[0];
  badge.textContent = `${firstName} · ${roleLabel}`;
  btn.parentNode.insertBefore(badge, btn);
}

/* ══════════════════════════════════════════════════════════════
   migrarDatosASupabase — botón en Configuración
   Sube todo lo que hay en localStorage a Supabase (primera vez)
   ══════════════════════════════════════════════════════════════ */
async function migrarDatosASupabase() {
  const btn = document.getElementById('btn-migrar-supabase');
  if (btn) { btn.disabled = true; btn.textContent = 'Migrando…'; }
  try {
    const orgId = _getOrgId();
    if (!orgId) {
      toast('Sin contexto de organización. Inicia sesión e intenta de nuevo.', 'error');
      return;
    }
    // Contar claves disponibles
    const count = [...Array(localStorage.length)]
      .map((_, i) => localStorage.key(i))
      .filter(k => k?.startsWith('stgl_')).length;
    if (!count) {
      toast('No hay datos locales para migrar. Captura algún dato primero.', 'info');
      return;
    }
    await _idbSnapshot();   // nivel 2: IndexedDB local (siempre)
    await _sbSnapshot();    // nivel 3: Supabase nube
    const esNube = orgId && !orgId.startsWith('local-');
    toast(esNube
      ? `☁️ ${count} bloques sincronizados con Supabase.`
      : `💾 ${count} bloques respaldados en IndexedDB (inicia sesión para sincronizar con la nube).`,
      'success');
    localStorage.setItem('stgl_supabase_migrated', Date.now().toString());
    _actualizarEstadoSync();
  } catch(e) {
    toast('Error al sincronizar: ' + (e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁️ Sincronizar ahora'; }
  }
}

/* Indicador de estado de sincronización en Configuración */
function _actualizarEstadoSync() {
  const el = document.getElementById('supabase-sync-status');
  if (!el) return;
  const ts = localStorage.getItem('stgl_supabase_migrated');
  if (ts) {
    const fecha   = new Date(+ts).toLocaleString('es-MX');
    const orgId   = _getOrgId() || '';
    const esLocal = !orgId || orgId.startsWith('local-');
    const label   = esLocal ? '💾 Respaldo local (IndexedDB)' : '☁️ Sincronizado con Supabase';
    el.innerHTML  = `<span style="color:var(--green);">${label} · última vez: ${fecha}</span>`;
    const btn = document.getElementById('btn-migrar-supabase');
    if (btn) btn.textContent = esLocal ? '💾 Respaldar ahora' : '☁️ Sincronizar ahora';
  } else {
    el.innerHTML = `<span style="color:var(--gold);">⚠️ Datos aún no respaldados en IndexedDB.</span>`;
  }
}

/* ── Sincronización automática de datos ──────────────────────────
   Safari cancela los fetch en vuelo durante beforeunload/pagehide,
   por eso sólo usamos visibilitychange (más confiable).
   Además, sync periódico cada 3 min como red de seguridad.
   ──────────────────────────────────────────────────────────────── */
let _periodicSyncTimer = null;

function _snapshotAll() {
  _idbSnapshot();
  _sbSnapshot();
}

/* Sync al ocultar la pestaña (cambio de tab, minimizar, cerrar).
   visibilitychange dispara ANTES de pagehide, cuando fetch aún puede completar. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _snapshotAll();
});

/* Sync periódico cada 3 minutos mientras la página está activa.
   Garantiza que a lo mucho 3 min de cambios queden sin subir a Supabase,
   incluso si la pestaña se cierra abruptamente sin disparar visibilitychange. */
function _startPeriodicSync() {
  if (_periodicSyncTimer) return;
  _periodicSyncTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') _sbSnapshot();
  }, 3 * 60 * 1000); // 3 minutos
}

/* ══════════════════════════════════════════════════════════════
   Utilidades generales
   ══════════════════════════════════════════════════════════════ */

/* ── HTML escape ── */
function escH(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── Toasts ── */
function toast(msg, type = 'info') {
  const container = document.getElementById('toasts') || (() => {
    const c = document.createElement('div');
    c.id = 'toasts'; c.className = 'toast-container';
    document.body.appendChild(c); return c;
  })();
  const icons = { success: '✓', error: '✕', info: '·' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || '·'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ── Date helpers ── */
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

/* ── Number helpers ── */
function fmtCLP(n) { return '$' + Number(n).toLocaleString('es-CL'); }

/* ── Upload zone ── */
function initUploadZone(zoneId, inputId, onFiles) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    onFiles([...e.dataTransfer.files]);
  });
  input.addEventListener('change', () => onFiles([...input.files]));
}

/* ── Modal ── */
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

/* ── Local storage helpers ── */
function loadRegistry(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch { return []; }
}
function saveRegistry(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
  _autoCaptureFromRegistry(key, data);
}

/* ── Auto-captura de conceptos y cuentas contables ── */
const _AUTO_CAPTURE_KEYS = [
  'stgl_mov_manual','stgl_egresos','stgl_recurrentes',
  'stgl_nomina','stgl_retenciones','stgl_mov_proyectados',
  'stgl_facturas','stgl_proyectos',
];
function _autoCaptureFromRegistry(key, data) {
  if (!_AUTO_CAPTURE_KEYS.includes(key) || !Array.isArray(data) || !data.length) return;
  try {
    const raw = localStorage.getItem('stgl_config');
    const cfg = raw ? JSON.parse(raw) : {};
    if (!cfg.catalogos) cfg.catalogos = {};
    if (!cfg.catalogos.conceptos)        cfg.catalogos.conceptos = [];
    if (!cfg.catalogos.cuentasContables) cfg.catalogos.cuentasContables = [];
    const cSet  = new Set(cfg.catalogos.conceptos);
    const ccSet = new Set(cfg.catalogos.cuentasContables);
    let changed = false;
    data.forEach(item => {
      const c  = (item.concepto   || '').trim();
      const cc = (item.cuentaCont || '').trim();
      if (c.length  >= 2 && !cSet.has(c))   { cSet.add(c);   cfg.catalogos.conceptos.push(c);         changed = true; }
      if (cc.length >= 2 && !ccSet.has(cc)) { ccSet.add(cc); cfg.catalogos.cuentasContables.push(cc); changed = true; }
    });
    if (changed) localStorage.setItem('stgl_config', JSON.stringify(cfg));
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   Directorio de contactos — clientes y proveedores
   stgl_directorio : permanente, sync Supabase
   stgl_cfdi_index : auto-poblado, auto-purgado (90 días / 3 usos)
   ══════════════════════════════════════════════════════════════ */
const _DIR_KEY        = 'stgl_directorio';
const _CIDX_KEY       = 'stgl_cfdi_index';
const _CIDX_TTL_DIAS  = 90;
const _CIDX_MIN_USOS  = 3;
function _stglHoy() { return new Date().toISOString().substring(0, 10); }

/* Búsqueda unificada en directorio + cfdi_index */
function _dirBuscar(q) {
  if (!q || q.length < 2) return [];
  const qn = q.toLowerCase();
  const dir = loadRegistry(_DIR_KEY);
  const idx = loadRegistry(_CIDX_KEY);
  return [...dir.map(e => ({...e, _f:'dir'})), ...idx.map(e => ({...e, _f:'idx'}))]
    .filter(e => (e.nombre||'').toLowerCase().includes(qn) || (e.rfc||'').toLowerCase().includes(qn))
    .sort((a, b) => (b.usos||0) - (a.usos||0))
    .slice(0, 8);
}

/* Agregar / actualizar entrada en directorio permanente */
function _dirAgregar(nombre, concepto, cuentaCont, rfc, tipo) {
  if (!nombre && !rfc) return;
  const dir = loadRegistry(_DIR_KEY);
  const e   = dir.find(x => (rfc && x.rfc === rfc) || (!rfc && x.nombre === nombre));
  if (e) {
    e.usos = (e.usos||0) + 1; e.fechaUltimoUso = _stglHoy();
    if (concepto)                              e.conceptoDefault   = concepto;
    if (cuentaCont && cuentaCont !== 'No Existe') e.cuentaContDefault = cuentaCont;
  } else {
    dir.push({ id: rfc || ('dir_' + Date.now()), rfc: rfc||'', nombre,
               tipo: tipo||'proveedor', conceptoDefault: concepto||'',
               cuentaContDefault: cuentaCont||'No Existe',
               usos: 1, fechaUltimoUso: _stglHoy(), origen: 'manual' });
  }
  saveRegistry(_DIR_KEY, dir);
}

/* Indexar proveedor desde CFDI — promueve automáticamente tras 3 usos */
function _cfdiIdxAgregar(rfc, nombre, concepto, cuentaCont) {
  if (!nombre && !rfc) return;
  const idx = loadRegistry(_CIDX_KEY);
  const e   = idx.find(x => (rfc && x.rfc === rfc) || (!rfc && x.nombre === nombre));
  if (e) {
    e.usos = (e.usos||1) + 1; e.fechaUltimoUso = _stglHoy();
    if (concepto)                              e.conceptoUltimoUso = concepto;
    if (cuentaCont && cuentaCont !== 'No Existe') e.cuentaContDefault = cuentaCont;
    if (e.usos >= _CIDX_MIN_USOS) {
      _dirAgregar(e.nombre, e.conceptoUltimoUso, e.cuentaContDefault, e.rfc, 'proveedor');
      saveRegistry(_CIDX_KEY, idx.filter(x => x !== e));
    } else {
      saveRegistry(_CIDX_KEY, idx);
    }
  } else {
    idx.push({ rfc: rfc||'', nombre, conceptoUltimoUso: concepto||'',
               cuentaContDefault: cuentaCont||'', usos: 1,
               fechaUltimoUso: _stglHoy(), fechaPrimeraVez: _stglHoy() });
    saveRegistry(_CIDX_KEY, idx);
  }
}

/* Purgar entradas de cfdi_index con < 3 usos y > 90 días sin aparecer */
function _cfdiIdxPurgar() {
  const idx = loadRegistry(_CIDX_KEY);
  if (!idx.length) return;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - _CIDX_TTL_DIAS);
  const clean  = idx.filter(e =>
    (e.usos||1) >= _CIDX_MIN_USOS ||
    new Date(e.fechaUltimoUso || e.fechaPrimeraVez || '2000-01-01') > cutoff
  );
  if (clean.length < idx.length) saveRegistry(_CIDX_KEY, clean);
}

/* ── Normalizador de nombre de cuenta ──────────────────────────────
   Dado cualquier string (p.ej. "Tarjeta de Crédito CLARA"),
   devuelve el alias canónico de stgl_saldos ("Clara").
   Orden: exacto → normalizado → contención → palabras comunes.
   ────────────────────────────────────────────────────────────────── */
function _normalizarCuenta(raw) {
  if (!raw) return raw;
  try {
    const saldos = JSON.parse(localStorage.getItem('stgl_saldos') || '[]');
    if (!saldos.length) return raw;
    const _n = s => (s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const rawN = _n(raw);

    // 1. Exacto
    const exact = saldos.find(s => s.cuenta === raw);
    if (exact) return exact.cuenta;

    // 2. Exacto normalizado
    const normExact = saldos.find(s => _n(s.cuenta) === rawN);
    if (normExact) return normExact.cuenta;

    // 3. Contención (uno contiene al otro)
    const partial = saldos.find(s => {
      const sN = _n(s.cuenta);
      return rawN.includes(sN) || sN.includes(rawN);
    });
    if (partial) return partial.cuenta;

    // 4. Mejor coincidencia por palabras comunes (min 2 chars)
    const rawWords = rawN.split(' ').filter(w => w.length >= 2);
    let best = null, bestScore = 0;
    saldos.forEach(s => {
      const sWords = _n(s.cuenta).split(' ').filter(w => w.length >= 2);
      const score  = sWords.filter(w => rawWords.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = s; }
    });
    if (best && bestScore > 0) return best.cuenta;
  } catch {}
  return raw; // sin match, devuelve el original
}

/* ── File size formatter ── */
function fmtSize(bytes) {
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/* ── Active nav ── */
function setActiveNav() {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(a => {
    if (a.getAttribute('href') === page) a.classList.add('active');
  });
}

/* ── Global config: branding + module visibility ── */
function hexToRgbStr(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : null;
}
function applyGlobalConfig() {
  try {
    const raw = localStorage.getItem('stgl_config');
    if (!raw) return;
    const cfg = JSON.parse(raw);
    const a   = cfg.apariencia;
    if (a?.colorPrimario) {
      document.documentElement.style.setProperty('--navy', a.colorPrimario);
      const rgb = hexToRgbStr(a.colorPrimario);
      if (rgb) document.documentElement.style.setProperty('--navy-pale', `rgba(${rgb},0.07)`);
    }
    if (a?.logo) {
      document.querySelectorAll('img.brand-logo').forEach(el => el.src = a.logo);
      document.querySelectorAll('footer img[alt="Santaglia"]').forEach(el => el.src = a.logo);
    }
    const nombre = a?.nombreSistema || cfg.empresa?.nombreComercial || cfg.empresa?.nombre;
    if (nombre) document.title = document.title.replace('Santaglia', nombre);
    if (cfg.modulos) {
      const navMap = {
        facturacion:'facturacion.html', proyectos:'proyectos.html',
        nomina:'nomina.html', retenciones:'retenciones.html',
        financiero:'financiero.html', egresos:'egresos.html',
        recurrentes:'recurrentes.html', proyectados:'proyectados.html',
        documentos:'documentos.html', galeria:'galeria.html',
      };
      Object.entries(navMap).forEach(([mod, href]) => {
        document.querySelectorAll(`.nav-menu-item[href="${href}"]`).forEach(el => {
          el.style.display = cfg.modulos[mod] === false ? 'none' : '';
        });
      });
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   Autenticación — protege todas las páginas excepto login.html
   ══════════════════════════════════════════════════════════════ */
async function _checkAuth() {
  try {
    const sb = await _initSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      // Limpiar cualquier estado de auth local caducado/corrupto
      // para evitar el loop login→dashboard→login
      try { await sb.auth.signOut({ scope: 'local' }); } catch {}
      location.href = 'login.html';
      return false;
    }
    return true;
  } catch {
    // Sin red: permitir acceso si hay datos locales (modo offline)
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith('stgl_')) return true;
    }
    location.href = 'login.html';
    return false;
  }
}

/* logout() — llamado por todos los botones "Salir" del sistema */
async function logout() {
  if (!confirm('¿Salir de Santaglia Compass?')) return;
  try {
    const sb = await _initSupabase();
    await sb.auth.signOut();
  } catch {}
  location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', async () => {
  const page = location.pathname.split('/').pop() || 'dashboard.html';

  // login.html no necesita verificación
  if (page === 'login.html') return;

  const authed = await _checkAuth();
  if (!authed) return;

  await _loadUserContext();    // Cargar org_id + rol del usuario
  await _checkAndRestore();    // Restaurar desde IDB o Supabase si localStorage vacío
  setActiveNav();
  applyGlobalConfig();
  _actualizarEstadoSync();
  _applyRoleUI(_getUserRole());
  _injectUserBadge(_getUserName(), _getUserRole());

  // Purgar cfdi_index silencioso (entradas viejas con pocos usos)
  setTimeout(_cfdiIdxPurgar, 3000);

  // Sync inicial (5 s después de arrancar) + arrancar el timer periódico
  setTimeout(() => {
    _idbSnapshot();        // nivel 2: IndexedDB local
    _sbSnapshot();         // nivel 3: Supabase nube
    _startPeriodicSync();  // activa sync cada 3 min
  }, 5000);
});

/* ══════════════════════════════════════════════════════════════
   Utilidades compartidas para importación Excel/CSV
   Usadas por: facturacion, financiero, configuracion, tiempo, recurrentes
   ══════════════════════════════════════════════════════════════ */

/** Carga SheetJS desde CDN (solo una vez) y ejecuta el callback */
function _cargarSheetJS(cb) {
  if (window.XLSX) { cb(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  s.onload = cb;
  s.onerror = () => { if (typeof toast === 'function') toast('No se pudo cargar el lector de Excel (requiere internet)', 'error'); };
  document.head.appendChild(s);
}

/**
 * Lee un archivo Excel (.xlsx/.xls), muestra selector de hojas si hay más de una,
 * y llama onRows(rows, nombreHoja) con el array de filas de la hoja elegida.
 * rows[0] = cabeceras, rows[1..] = datos.
 */
function _seleccionarHojaExcel(file, onRows) {
  _cargarSheetJS(() => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        const sheets = wb.SheetNames;
        if (!sheets.length) { if (typeof toast === 'function') toast('El archivo Excel no tiene hojas', 'error'); return; }

        const leerHoja = nombre => {
          const ws   = wb.Sheets[nombre];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
          onRows(rows, nombre);
        };

        if (sheets.length === 1) { leerHoja(sheets[0]); return; }
        _mostrarSelectorHojas(sheets, leerHoja);

      } catch(err) {
        if (typeof toast === 'function') toast('Error al leer el Excel: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Modal selector de hojas — usado por _seleccionarHojaExcel */
function _mostrarSelectorHojas(sheets, onSelect) {
  const existing = document.getElementById('_modal-sheet-selector');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = '_modal-sheet-selector';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;border-radius:12px;padding:1.5rem;min-width:320px;max-width:480px;width:90vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.18);font-family:var(--font);';

  const titulo = document.createElement('div');
  titulo.style.cssText = 'font-family:var(--brand);font-size:0.95rem;font-weight:800;color:var(--navy);margin-bottom:0.3rem;flex-shrink:0;';
  titulo.textContent = 'Selecciona la hoja a importar';

  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:0.73rem;color:var(--text-dim);margin-bottom:1rem;flex-shrink:0;';
  sub.textContent = `El archivo tiene ${sheets.length} hojas. ¿Cuál contiene los datos?`;

  const lista = document.createElement('div');
  lista.style.cssText = 'display:flex;flex-direction:column;gap:0.45rem;overflow-y:auto;flex:1 1 auto;padding-right:0.25rem;';

  sheets.forEach(nombre => {
    const btn = document.createElement('button');
    btn.style.cssText = 'padding:0.6rem 1rem;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);font-size:0.82rem;font-family:var(--font);cursor:pointer;text-align:left;color:var(--text);transition:all 0.15s;flex-shrink:0;';
    btn.textContent = '📋 ' + nombre;
    btn.onmouseenter = () => { btn.style.borderColor = 'var(--navy)'; btn.style.background = 'var(--navy-pale)'; };
    btn.onmouseleave = () => { btn.style.borderColor = 'var(--border)'; btn.style.background = 'var(--bg)'; };
    btn.onclick = () => { modal.remove(); onSelect(nombre); };
    lista.appendChild(btn);
  });

  const cancelar = document.createElement('button');
  cancelar.style.cssText = 'margin-top:0.85rem;width:100%;padding:0.5rem;border:none;background:none;color:var(--text-dim);font-size:0.75rem;cursor:pointer;flex-shrink:0;';
  cancelar.textContent = 'Cancelar';
  cancelar.onclick = () => modal.remove();

  card.append(titulo, sub, lista, cancelar);
  modal.appendChild(card);
  modal.onclick = ev => { if (ev.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

/**
 * Convierte array de rows (de SheetJS) a File CSV en memoria.
 * Útil para módulos que ya tienen un parser CSV y solo necesitan
 * adaptar la entrada de Excel.
 */
function _rowsToCSVFile(rows, nombre) {
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  return new File([csv], (nombre || 'datos') + '.csv', { type: 'text/csv' });
}
