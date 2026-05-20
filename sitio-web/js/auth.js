/* ─── SANTAGLIA COMPASS · Auth ─── */
/* Contraseña por defecto: Santaglia2026 */

const AUTH_SALT = 'stgl_2026';
// btoa("Santaglia2026" + "stgl_2026") — funciona en HTTP y HTTPS
const AUTH_HASH = 'U2FudGFnbGlhMjAyNnN0Z2xfMjAyNg==';
const SESSION_KEY = 'stgl_session';

function hashInput(text) {
  // btoa simple — independiente del protocolo (HTTP o HTTPS)
  return btoa(text + AUTH_SALT);
}

function login(password) {
  if (hashInput(password) === AUTH_HASH) {
    sessionStorage.setItem(SESSION_KEY, btoa(Date.now().toString()));
    return true;
  }
  return false;
}

function isAuthenticated() {
  return !!sessionStorage.getItem(SESSION_KEY);
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  window.location.href = 'index.html';
}

function requireAuth() {
  if (!isAuthenticated()) {
    window.location.href = 'index.html';
  }
}
