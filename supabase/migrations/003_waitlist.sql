-- ============================================================
-- Santaglia Compass — Waitlist CRM
-- Migración 003: Tabla de contactos de lista de espera
-- ============================================================

CREATE TABLE IF NOT EXISTS waitlist_contacts (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email               TEXT        UNIQUE NOT NULL,
  nombre              TEXT,
  fuente              TEXT        DEFAULT 'santaglia.app landing',
  submitted_at        TIMESTAMPTZ DEFAULT NOW(),
  status              TEXT        DEFAULT 'pendiente',
  -- pendiente | bienvenida | seguimiento_1 | seguimiento_2 | onboarded | descartado
  welcome_sent_at     TIMESTAMPTZ,
  followup_1_sent_at  TIMESTAMPTZ,
  followup_2_sent_at  TIMESTAMPTZ,
  onboarding_at       TIMESTAMPTZ,
  notas               TEXT,
  referido_por        TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Índice por status para filtros rápidos
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist_contacts (status);
CREATE INDEX IF NOT EXISTS idx_waitlist_submitted ON waitlist_contacts (submitted_at DESC);

-- RLS: solo usuarios autenticados (admins del sistema)
ALTER TABLE waitlist_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_admin_only" ON waitlist_contacts;
CREATE POLICY "authenticated_admin_only" ON waitlist_contacts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_waitlist_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_waitlist_updated_at ON waitlist_contacts;
CREATE TRIGGER trg_waitlist_updated_at
  BEFORE UPDATE ON waitlist_contacts
  FOR EACH ROW EXECUTE FUNCTION update_waitlist_updated_at();

-- Insertar el primer contacto manualmente (el de hoy)
INSERT INTO waitlist_contacts (email, fuente, submitted_at, status)
VALUES ('rpolancomaldonado@gmail.com', 'santaglia.app landing', '2026-05-25 21:01:00+00', 'pendiente')
ON CONFLICT (email) DO NOTHING;
