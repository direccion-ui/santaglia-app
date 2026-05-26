-- ============================================================
-- SANTAGLIA COMPASS — Schema inicial v1.0
-- Ejecutar en Supabase SQL Editor (en orden, una sección a la vez)
-- ============================================================

-- ============================================================
-- SECCIÓN 1: EXTENSIONES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- SECCIÓN 2: ORGANIZACIONES (tenants / empresas)
-- ============================================================
CREATE TABLE IF NOT EXISTS organizaciones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          text NOT NULL,
  rfc             text NOT NULL,
  regimen_fiscal  text,                          -- 612, 626, 630, etc.
  plan            text NOT NULL DEFAULT 'basico' CHECK (plan IN ('basico','estandar','pro')),
  trial_ends_at   timestamptz,
  sub_status      text NOT NULL DEFAULT 'trial'
                  CHECK (sub_status IN ('trial','active','paused','cancelled','past_due')),
  pausa_hasta     timestamptz,                   -- para pausa de suscripción
  pausas_usadas   integer NOT NULL DEFAULT 0,    -- máx 2/año
  referido_codigo text UNIQUE,                   -- código único para referidos
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE organizaciones IS 'Empresas/tenants. Una empresa = un RFC = un tenant.';


-- ============================================================
-- SECCIÓN 3: PERFILES (extiende auth.users)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nombre          text,
  telefono        text,
  current_org_id  uuid REFERENCES organizaciones(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE profiles IS 'Perfil del usuario, creado automáticamente al registrarse.';

-- Trigger: crear profile automáticamente al registrar usuario
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, nombre)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'nombre')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================
-- SECCIÓN 4: RELACIÓN USUARIO ↔ ORGANIZACIÓN (N:M)
-- Soporta Multi-Emprendedor (Roadmap Fase 5)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_org (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  rol        text NOT NULL DEFAULT 'owner' CHECK (rol IN ('owner','admin','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

COMMENT ON TABLE user_org IS 'N:M usuario-empresa. Un usuario puede tener varias empresas (company switcher).';


-- ============================================================
-- SECCIÓN 5: MOVIMIENTOS FINANCIEROS
-- Reemplaza localStorage stgl_mov_manual
-- ============================================================
CREATE TABLE IF NOT EXISTS movimientos (
  id              text PRIMARY KEY,              -- MAN-xxx, UUID CFDI, o SAT-xxx
  org_id          uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  fecha           date NOT NULL,                 -- fecha del movimiento (transacción)
  fecha_registro  date NOT NULL DEFAULT CURRENT_DATE, -- fecha captura en Compass
  mov             text NOT NULL CHECK (mov IN ('Ingresos','Egresos')),
  tipo            text,                          -- CFDI, Recibo, Nómina, etc.
  descripcion     text,
  concepto        text,
  cuenta_contable text,
  folio           text,
  cuenta          text,                          -- cuenta bancaria
  origen          text,
  destino         text,
  entradas        numeric(15,2),
  salidas         numeric(15,2),
  origen_ref      text NOT NULL DEFAULT 'manual'
                  CHECK (origen_ref IN ('manual','excel','sat','traspaso')),
  traspaso_id     text,                          -- agrupa las dos patas del traspaso
  cfdi_uuid       text,                          -- UUID del CFDI (36 chars)
  saldo_ajustado  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mov_org_fecha    ON movimientos (org_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_mov_org_origen   ON movimientos (org_id, origen_ref);
CREATE INDEX IF NOT EXISTS idx_mov_cfdi_uuid    ON movimientos (cfdi_uuid) WHERE cfdi_uuid IS NOT NULL;

COMMENT ON TABLE movimientos IS 'Movimientos financieros por empresa. origen_ref=sat para CFDI descargados del SAT.';


-- ============================================================
-- SECCIÓN 6: CREDENCIALES SAT (encriptadas por tenant)
-- Para Conexión SAT — Descarga Masiva (Roadmap Fase 3)
-- ============================================================
CREATE TABLE IF NOT EXISTS sat_credenciales (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  rfc                    text NOT NULL,
  -- Autenticación CIEC (encriptada AES-256 en Edge Function antes de guardar)
  ciec_encrypted         text,
  -- Autenticación por certificado (.cer + .key)
  cer_encrypted          text,
  key_encrypted          text,
  -- Estado de conexión
  conectado              boolean NOT NULL DEFAULT false,
  ultima_sync            timestamptz,
  sync_periodo_inicio    date,                   -- rango más reciente sincronizado
  sync_periodo_fin       date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)                                -- una sola config SAT por empresa
);

COMMENT ON TABLE sat_credenciales IS 'Credenciales SAT por empresa. CIEC/certs encriptados AES-256. Nunca en texto plano.';


-- ============================================================
-- SECCIÓN 7: LOG DE SINCRONIZACIÓN SAT
-- ============================================================
CREATE TABLE IF NOT EXISTS sat_sync_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  rfc           text NOT NULL,
  fecha_inicio  date NOT NULL,
  fecha_fin     date NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('emitidos','recibidos','ambos')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','completed','failed')),
  cfdi_count    integer,
  solicitud_id  text,                            -- ID de solicitud SAT (async)
  error_msg     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sat_log_org ON sat_sync_log (org_id, created_at DESC);

COMMENT ON TABLE sat_sync_log IS 'Historial de sincronizaciones SAT. SAT toma hasta 48hrs; máx 10 req/día/RFC.';


-- ============================================================
-- SECCIÓN 8: PROGRAMA DE REFERIDOS (Roadmap Fase 6)
-- ============================================================
CREATE TABLE IF NOT EXISTS referidos (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo                   text NOT NULL UNIQUE,          -- código único del link
  referidor_org_id         uuid REFERENCES organizaciones(id) ON DELETE SET NULL,
  referido_org_id          uuid REFERENCES organizaciones(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'pendiente'
                           CHECK (status IN ('pendiente','activo','pagado','expirado')),
  -- Beneficios
  dto_referido_pct         numeric(5,2) NOT NULL DEFAULT 20.0,  -- 20% off 3 meses
  dto_referido_meses       integer NOT NULL DEFAULT 3,
  bono_referidor_meses     integer NOT NULL DEFAULT 1,          -- 1 mes gratis
  -- Tracking
  click_count              integer NOT NULL DEFAULT 0,
  conversion_at            timestamptz,
  primer_pago_at           timestamptz,
  referidor_bonificado_at  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz                    -- links expiran después de 90 días sin conversión
);

CREATE INDEX IF NOT EXISTS idx_ref_codigo        ON referidos (codigo);
CREATE INDEX IF NOT EXISTS idx_ref_referidor_org ON referidos (referidor_org_id);

COMMENT ON TABLE referidos IS 'Programa bilateral: referido obtiene 20% off 3m; referidor obtiene 1 mes gratis al confirmar pago.';


-- ============================================================
-- SECCIÓN 9: HEALTH SCORE DEL CLIENTE (Roadmap Fase 7)
-- ============================================================
CREATE TABLE IF NOT EXISTS health_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  score            integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  -- Señales (actualizadas por triggers/Edge Functions)
  ultimo_login     timestamptz,
  dias_sin_login   integer,                      -- calculado por Edge Function diaria
  modulos_activos  integer NOT NULL DEFAULT 0,   -- módulos usados en últimos 30 días
  sat_conectado    boolean NOT NULL DEFAULT false,
  alertas_vistas   integer NOT NULL DEFAULT 0,
  pagos_al_dia     boolean NOT NULL DEFAULT true,
  -- Resultado
  riesgo           text,                         -- 'bajo' | 'medio' | 'alto' — calculado por Edge Function
  outreach_enviado boolean NOT NULL DEFAULT false,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);

COMMENT ON TABLE health_scores IS 'Score 0-100 por empresa. Score<40 dispara outreach automático. Actualizado diariamente por Edge Function.';


-- ============================================================
-- SECCIÓN 10: DUNNING — LOG DE REINTENTOS DE COBRO (Fase 6)
-- ============================================================
CREATE TABLE IF NOT EXISTS dunning_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizaciones(id) ON DELETE CASCADE,
  intento      integer NOT NULL CHECK (intento IN (1,2,3)),  -- D+1, D+3, D+7
  status       text NOT NULL CHECK (status IN ('pending','success','failed')),
  monto        numeric(10,2),
  error_msg    text,
  intentado_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE dunning_log IS 'Reintentos de cobro: D+1, D+3, D+7. Tras D+7 fallido → 7 días gracia → suspensión.';


-- ============================================================
-- SECCIÓN 11: ROW LEVEL SECURITY (RLS)
-- Cada usuario solo ve datos de sus propias organizaciones
-- ============================================================

-- Habilitar RLS en todas las tablas
ALTER TABLE organizaciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_org           ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sat_credenciales   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sat_sync_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE referidos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_scores      ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_log        ENABLE ROW LEVEL SECURITY;


-- Helper function: devuelve los org_ids a los que tiene acceso el usuario actual
CREATE OR REPLACE FUNCTION my_org_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT org_id FROM user_org WHERE user_id = auth.uid();
$$;


-- POLÍTICAS: profiles
CREATE POLICY "perfil propio" ON profiles
  FOR ALL USING (id = auth.uid());

-- POLÍTICAS: organizaciones
CREATE POLICY "ver mis orgs" ON organizaciones
  FOR SELECT USING (id IN (SELECT my_org_ids()));

CREATE POLICY "actualizar mis orgs" ON organizaciones
  FOR UPDATE USING (id IN (SELECT my_org_ids()));

-- POLÍTICAS: user_org
CREATE POLICY "ver mis membresías" ON user_org
  FOR SELECT USING (user_id = auth.uid());

-- POLÍTICAS: movimientos
CREATE POLICY "ver movimientos de mis orgs" ON movimientos
  FOR SELECT USING (org_id IN (SELECT my_org_ids()));

CREATE POLICY "insertar en mis orgs" ON movimientos
  FOR INSERT WITH CHECK (org_id IN (SELECT my_org_ids()));

CREATE POLICY "actualizar mis movimientos" ON movimientos
  FOR UPDATE USING (org_id IN (SELECT my_org_ids()));

CREATE POLICY "eliminar mis movimientos" ON movimientos
  FOR DELETE USING (org_id IN (SELECT my_org_ids()));

-- POLÍTICAS: sat_credenciales (solo owner/admin)
CREATE POLICY "ver sat de mis orgs" ON sat_credenciales
  FOR SELECT USING (org_id IN (SELECT my_org_ids()));

CREATE POLICY "gestionar sat de mis orgs" ON sat_credenciales
  FOR ALL USING (
    org_id IN (SELECT org_id FROM user_org WHERE user_id = auth.uid() AND rol IN ('owner','admin'))
  );

-- POLÍTICAS: sat_sync_log
CREATE POLICY "ver sync log de mis orgs" ON sat_sync_log
  FOR SELECT USING (org_id IN (SELECT my_org_ids()));

-- POLÍTICAS: referidos
CREATE POLICY "ver mis referidos" ON referidos
  FOR SELECT USING (referidor_org_id IN (SELECT my_org_ids())
                 OR referido_org_id  IN (SELECT my_org_ids()));

-- POLÍTICAS: health_scores
CREATE POLICY "ver health score de mis orgs" ON health_scores
  FOR SELECT USING (org_id IN (SELECT my_org_ids()));

-- POLÍTICAS: dunning_log
CREATE POLICY "ver dunning de mis orgs" ON dunning_log
  FOR SELECT USING (org_id IN (SELECT my_org_ids()));


-- ============================================================
-- SECCIÓN 12: FUNCIÓN updated_at AUTOMÁTICO
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_org_updated_at
  BEFORE UPDATE ON organizaciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_mov_updated_at
  BEFORE UPDATE ON movimientos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sat_cred_updated_at
  BEFORE UPDATE ON sat_credenciales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- SECCIÓN 13: DATOS DE PRUEBA (opcional — borrar en producción)
-- ============================================================

-- Descomenta para crear una organización de prueba:
-- INSERT INTO organizaciones (nombre, rfc, regimen_fiscal, plan, sub_status)
-- VALUES ('Demo Empresa SA de CV', 'DEM010101AAA', '612', 'estandar', 'active');
