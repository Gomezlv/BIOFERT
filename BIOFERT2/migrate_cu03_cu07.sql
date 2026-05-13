-- CU-03, CU-05, CU-06, CU-07 — migración incremental sobre esquema MetaGanado existente.
-- Ejecutar una vez: psql -d metaganado -f migrate_cu03_cu07.sql

-- ─── Usuarios: estado de cuenta y tipos extendidos ───
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('admin', 'ganadero', 'tecnico', 'veterinario'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_account_status_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_account_status_check
      CHECK (account_status IN ('active', 'suspended'));
  END IF;
END $$;

UPDATE users SET account_status = 'active' WHERE account_status IS NULL OR account_status = '';

-- ─── Catálogo científico (recommendations) ───
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS intervention_kind TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recommendations_intervention_kind_check') THEN
    ALTER TABLE recommendations ADD CONSTRAINT recommendations_intervention_kind_check
      CHECK (intervention_kind IS NULL OR intervention_kind IN ('aditivo','forraje','practica'));
  END IF;
END $$;

ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS dosage_detail TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS applicability_conditions TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS bibliographic_refs TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS local_provider TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS estimated_cost_cop NUMERIC(12,2);
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS updated_by_user_id INT REFERENCES users(id) ON DELETE SET NULL;

-- ─── Seguimiento en finca ───
ALTER TABLE farm_recommendations DROP CONSTRAINT IF EXISTS farm_recommendations_status_check;
ALTER TABLE farm_recommendations ADD CONSTRAINT farm_recommendations_status_check
  CHECK (status IN ('pendiente','aplicada','descartada','en_seguimiento'));

ALTER TABLE farm_recommendations ADD COLUMN IF NOT EXISTS impact_review_scheduled_at TIMESTAMPTZ;
ALTER TABLE farm_recommendations ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ;

-- ─── Retroalimentación (CU-05) ───
CREATE TABLE IF NOT EXISTS intervention_feedback (
  id SERIAL PRIMARY KEY,
  farm_recommendation_id INT NOT NULL REFERENCES farm_recommendations(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  production_change_pct NUMERIC(8,2),
  real_cost_cop NUMERIC(14,2),
  livestock_acceptability TEXT NOT NULL CHECK (livestock_acceptability IN ('baja','media','alta')),
  observations TEXT,
  queued_for_model_training BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intervention_feedback_farm_rec ON intervention_feedback(farm_recommendation_id);

-- ─── Acceso delegado a predios (CU-06) ───
CREATE TABLE IF NOT EXISTS farm_user_access (
  id SERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_level TEXT NOT NULL CHECK (permission_level IN ('lectura','edicion')),
  granted_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_farm_user_access_user ON farm_user_access(user_id);

-- Datos demo: enriquecer catálogo si columnas nuevas están vacías
UPDATE recommendations SET intervention_kind = 'aditivo', dosage_detail = COALESCE(dosage_detail, notes),
  applicability_conditions = COALESCE(applicability_conditions, 'Lotes con dieta estable y manejo de concentrado controlado.'),
  bibliographic_refs = COALESCE(bibliographic_refs, 'Hristov et al. (2015) mitigación de metano ruminal; revisión técnica FAO.'),
  local_provider = COALESCE(local_provider, 'Distribuidor regional (demo)'),
  estimated_cost_cop = COALESCE(estimated_cost_cop, 120000 + id * 15000),
  updated_at = NOW()
WHERE id IN (SELECT id FROM recommendations);

UPDATE recommendations SET intervention_kind = 'forraje' WHERE title ILIKE '%lino%' OR title ILIKE '%forraje%';
UPDATE recommendations SET intervention_kind = 'practica' WHERE title ILIKE '%rotación%' OR title ILIKE '%potrero%' OR title ILIKE '%sombras%';
