-- Migración incremental: roles admin/ganadero y auditoría.
-- Ejecutar una vez sobre una BD ya creada con el esquema anterior.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'ganadero';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_account_type_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_account_type_check
      CHECK (account_type IN ('admin', 'ganadero'));
  END IF;
END $$;

UPDATE users SET account_type = 'ganadero' WHERE account_type IS NULL OR account_type = '';

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users (full_name, role, account_type, location, email, password_hash)
SELECT
  'Supervisor Plataforma',
  'Administración',
  'admin',
  'Bogotá, Colombia',
  'admin@biofert.demo',
  '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = 'admin@biofert.demo');
