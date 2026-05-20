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
const _SB_TABLE = 'stgl_kv';
let _sbClient   = null;
let _sbReady    = false;

/* Contexto de sesión del usuario activo */
let _stglOrgId    = null;
let _stglUserRole = null;
let _stglUserName = null;

function _getOrgId()    { return _stglOrgId    || sessionStorage.getItem('stgl_org_id');    }
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

/* Escribe un par clave/valor en Supabase (fire-and-forget) */
function _sbWrite(key, value) {
  const orgId = _getOrgId();
  if (!orgId) return; // sin contexto de org aún
  _initSupabase().then(sb =>
    sb.from(_SB_TABLE).upsert({ key, value, org_id: orgId, updated_at: new Date().toISOString() })
  ).catch(() => {});
}

/* Lee todos los stgl_* desde Supabase */
async function _sbReadAll() {
  try {
    const sb = await _initSupabase();
    const { data, error } = await sb.from(_SB_TABLE).select('key, value, updated_at');
    if (error) return [];
    return data || [];
  } catch { return []; }
}

/* Sube todos los stgl_* de localStorage a Supabase en lote */
async function _sbSnapshot() {
  const orgId = _getOrgId();
  if (!orgId) return;
  try {
    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('stgl_'))
        rows.push({ key: k, value: localStorage.getItem(k), org_id: orgId, updated_at: new Date().toISOString() });
    }
    if (!rows.length) return;
    const sb = await _initSupabase();
    await sb.from(_SB_TABLE).upsert(rows);
  } catch {}
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
  // ¿localStorage ya tiene datos? No hay nada que restaurar.
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith('stgl_')) return;
  }

  // Intento 1: IndexedDB (local, rápido, sin red)
  const idb = await _idbReadAll();
  const idbEntries = Object.entries(idb).filter(([k]) => k.startsWith('stgl_'));
  if (idbEntries.length) {
    const _orig = localStorage.setItem.bind(localStorage);
    idbEntries.forEach(([k, v]) => { if (v != null) _orig(k, v); });
    const ts = idb[_STGL_TS_KEY] ? new Date(+idb[_STGL_TS_KEY]).toLocaleString('es-MX') : '—';
    toast(`✅ Datos restaurados desde respaldo local (${ts}). Recargando…`, 'success');
    setTimeout(() => location.reload(), 2000);
    return;
  }

  // Intento 2: Supabase (nube)
  try {
    const rows = await _sbReadAll();
    const stglRows = rows.filter(r => r.key.startsWith('stgl_'));
    if (stglRows.length) {
      const _orig = localStorage.setItem.bind(localStorage);
      stglRows.forEach(({ key, value }) => { if (value != null) _orig(key, value); });
      // También llenar IndexedDB con lo que vino de la nube
      stglRows.forEach(({ key, value }) => _idbWrite(key, value));
      toast(`☁️ Datos restaurados desde la nube (${stglRows.length} bloques). Recargando…`, 'success');
      setTimeout(() => location.reload(), 2000);
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   _loadUserContext — carga org_id + rol después del login
   ══════════════════════════════════════════════════════════════ */
async function _loadUserContext() {
  try {
    const sb = await _initSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;

    const { data: profile } = await sb
      .from('user_profiles')
      .select('org_id, role, full_name')
      .eq('user_id', session.user.id)
      .single();

    if (profile) {
      _stglOrgId    = profile.org_id;
      _stglUserRole = profile.role;
      _stglUserName = profile.full_name || session.user.email;
      sessionStorage.setItem('stgl_org_id',    _stglOrgId);
      sessionStorage.setItem('stgl_user_role', _stglUserRole);
      sessionStorage.setItem('stgl_user_name', _stglUserName);
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
      toast('Sin contexto de organización. Recarga la página e intenta de nuevo.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '☁️ Sincronizar ahora'; }
      return;
    }
    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('stgl_'))
        rows.push({ key: k, value: localStorage.getItem(k), org_id: orgId, updated_at: new Date().toISOString() });
    }
    if (!rows.length) {
      toast('No hay datos locales para migrar. Captura algún dato primero.', 'info');
      if (btn) { btn.disabled = false; btn.textContent = '☁️ Sincronizar ahora'; }
      return;
    }
    const sb = await _initSupabase();
    const { error } = await sb.from(_SB_TABLE).upsert(rows);
    if (error) throw error;
    _idbSnapshot(); // también respaldar en IndexedDB local
    toast(`☁️ ${rows.length} bloques sincronizados en nube e IndexedDB.`, 'success');
    localStorage.setItem('stgl_supabase_migrated', Date.now().toString());
    _actualizarEstadoSync();
  } catch(e) {
    toast('Error al migrar: ' + (e.message || e), 'error');
    if (btn) { btn.disabled = false; btn.textContent = '☁️ Migrar datos a Supabase'; }
  }
}

/* Indicador de estado de sincronización en Configuración */
function _actualizarEstadoSync() {
  const el = document.getElementById('supabase-sync-status');
  if (!el) return;
  const ts = localStorage.getItem('stgl_supabase_migrated');
  if (ts) {
    const fecha = new Date(+ts).toLocaleString('es-MX');
    el.innerHTML = `<span style="color:var(--green);">☁️ Sincronizado con Supabase · última vez: ${fecha}</span>`;
    const btn = document.getElementById('btn-migrar-supabase');
    if (btn) btn.textContent = '☁️ Sincronizar ahora';
  } else {
    el.innerHTML = `<span style="color:var(--gold);">⚠️ Datos aún no sincronizados con la nube.</span>`;
  }
}

/* Snapshot a ambos niveles al ocultar/cerrar la página */
function _snapshotAll() {
  _idbSnapshot();
  _sbSnapshot();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _snapshotAll();
});
window.addEventListener('pagehide',     _snapshotAll);
window.addEventListener('beforeunload', _snapshotAll);

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

  // Auto-sync al arrancar: si hay datos en localStorage, empujarlos a IDB y Supabase
  // Se corre en background para no bloquear el render
  setTimeout(() => {
    _idbSnapshot();   // nivel 2: IndexedDB local
    _sbSnapshot();    // nivel 3: Supabase nube
  }, 3000);
});
