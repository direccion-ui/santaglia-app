// ============================================================
// SANTAGLIA COMPASS — Configuración Supabase
// ============================================================
// Proyecto: Compass
// Region:   South America (São Paulo) — sa-east-1
// URL:      https://vblazgxsyidxttobiszt.supabase.co
// ============================================================

const SUPABASE_URL  = 'https://vblazgxsyidxttobiszt.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_T6iu_Tk9mxxXdBMngfqE8A_hPCH4cXA';

// Inicializar cliente (requiere @supabase/supabase-js v2+)
// En HTML puro se carga via CDN:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// HELPERS DE AUTENTICACIÓN
// ============================================================

async function signUp(email, password, nombre) {
  const { data, error } = await db.auth.signUp({
    email,
    password,
    options: { data: { nombre } }
  });
  return { data, error };
}

async function signIn(email, password) {
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  return { data, error };
}

async function signOut() {
  const { error } = await db.auth.signOut();
  return { error };
}

async function getUser() {
  const { data: { user } } = await db.auth.getUser();
  return user;
}

// ============================================================
// HELPERS DE ORGANIZACIONES
// ============================================================

async function crearOrganizacion({ nombre, rfc, regimenFiscal, plan = 'basico' }) {
  const user = await getUser();
  if (!user) return { error: 'No autenticado' };

  // 1. Crear la organización
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 14); // 14 días de trial

  const { data: org, error: orgError } = await db
    .from('organizaciones')
    .insert({
      nombre,
      rfc: rfc.toUpperCase(),
      regimen_fiscal: regimenFiscal,
      plan,
      trial_ends_at: trialEndsAt.toISOString(),
      sub_status: 'trial'
    })
    .select()
    .single();

  if (orgError) return { error: orgError };

  // 2. Vincular usuario como owner
  const { error: linkError } = await db
    .from('user_org')
    .insert({ user_id: user.id, org_id: org.id, rol: 'owner' });

  if (linkError) return { error: linkError };

  // 3. Actualizar current_org del perfil
  await db.from('profiles').update({ current_org_id: org.id }).eq('id', user.id);

  return { data: org };
}

async function getMisOrganizaciones() {
  const { data, error } = await db
    .from('user_org')
    .select('rol, organizaciones(*)')
    .order('created_at');
  return { data, error };
}

async function getOrgActual(orgId) {
  const { data, error } = await db
    .from('organizaciones')
    .select('*')
    .eq('id', orgId)
    .single();
  return { data, error };
}

// ============================================================
// HELPERS DE MOVIMIENTOS
// ============================================================

async function getMovimientos(orgId, { fechaInicio, fechaFin, mov } = {}) {
  let q = db.from('movimientos').select('*').eq('org_id', orgId);
  if (fechaInicio) q = q.gte('fecha', fechaInicio);
  if (fechaFin)    q = q.lte('fecha', fechaFin);
  if (mov)         q = q.eq('mov', mov);
  q = q.order('fecha', { ascending: true })
       .order('fecha_registro', { ascending: true });
  const { data, error } = await q;
  return { data, error };
}

async function upsertMovimiento(orgId, mov) {
  const { data, error } = await db
    .from('movimientos')
    .upsert({ ...mov, org_id: orgId }, { onConflict: 'id' })
    .select()
    .single();
  return { data, error };
}

async function deleteMovimiento(id) {
  const { error } = await db.from('movimientos').delete().eq('id', id);
  return { error };
}

// ============================================================
// TEST DE CONEXIÓN
// (ejecutar en consola del navegador para verificar)
// ============================================================
// async function testConexion() {
//   const { data, error } = await db.from('organizaciones').select('count');
//   console.log(error ? '❌ Error:' : '✅ Conectado:', error || data);
// }
// testConexion();
