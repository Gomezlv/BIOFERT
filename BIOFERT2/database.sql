-- MetaGanado (DEMO) - PostgreSQL schema + seed data
-- Ejecuta este archivo dentro de la BD "metaganado".

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS co2eq_reduction_monthly;
DROP TABLE IF EXISTS ch4_emissions_hourly;
DROP TABLE IF EXISTS intervention_feedback;
DROP TABLE IF EXISTS farm_recommendations;
DROP TABLE IF EXISTS sensor_readings;
DROP TABLE IF EXISTS sensors;
DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS farm_user_access;
DROP TABLE IF EXISTS farms;
DROP TABLE IF EXISTS users;

-- Usuario (dueño de una o más fincas)
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  full_name      TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'Ganadero',
  account_type   TEXT NOT NULL DEFAULT 'ganadero' CHECK (account_type IN ('admin', 'ganadero', 'tecnico', 'veterinario')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended')),
  location       TEXT,
  email          TEXT UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE farms (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  location      TEXT,
  area_ha       NUMERIC(10,2),
  heads_active  INT NOT NULL DEFAULT 0 CHECK (heads_active >= 0),
  breeds_text   TEXT,
  thermal_floor TEXT,
  altitude_m    INT,
  production_model TEXT,
  certification_step INT NOT NULL DEFAULT 2 CHECK (certification_step BETWEEN 1 AND 6),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Acceso delegado a predios (CU-06): lectura o edición sin ser titular
CREATE TABLE farm_user_access (
  id                   SERIAL PRIMARY KEY,
  farm_id              INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id              INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_level     TEXT NOT NULL CHECK (permission_level IN ('lectura','edicion')),
  granted_by_user_id   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, user_id)
);

CREATE TABLE sensors (
  id            SERIAL PRIMARY KEY,
  farm_id       INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  zone          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('activo','alerta','inactivo')),
  battery_pct   INT NOT NULL CHECK (battery_pct BETWEEN 0 AND 100),
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, code)
);

CREATE TABLE sensor_readings (
  id            SERIAL PRIMARY KEY,
  sensor_id     INT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  ch4_ppm       NUMERIC(10,2) NOT NULL CHECK (ch4_ppm >= 0),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recommendations (
  id                       SERIAL PRIMARY KEY,
  title                    TEXT NOT NULL,
  expected_reduction_pct   NUMERIC(5,2),
  difficulty               TEXT NOT NULL CHECK (difficulty IN ('facil','media','alta')),
  notes                    TEXT,
  intervention_kind        TEXT CHECK (intervention_kind IS NULL OR intervention_kind IN ('aditivo','forraje','practica')),
  dosage_detail            TEXT,
  applicability_conditions TEXT,
  bibliographic_refs       TEXT,
  local_provider           TEXT,
  estimated_cost_cop       NUMERIC(12,2),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id       INT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE farm_recommendations (
  id                         SERIAL PRIMARY KEY,
  farm_id                    INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  recommendation_id        INT NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  status                     TEXT NOT NULL CHECK (status IN ('pendiente','aplicada','descartada','en_seguimiento')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at                 TIMESTAMPTZ,
  impact_review_scheduled_at TIMESTAMPTZ,
  tracking_started_at        TIMESTAMPTZ,
  UNIQUE (farm_id, recommendation_id)
);

CREATE TABLE intervention_feedback (
  id                         SERIAL PRIMARY KEY,
  farm_recommendation_id     INT NOT NULL REFERENCES farm_recommendations(id) ON DELETE CASCADE,
  user_id                    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  production_change_pct      NUMERIC(8,2),
  real_cost_cop              NUMERIC(14,2),
  livestock_acceptability    TEXT NOT NULL CHECK (livestock_acceptability IN ('baja','media','alta')),
  observations               TEXT,
  queued_for_model_training  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Emisiones agregadas por hora (para la gráfica de 24h en Inicio)
-- Nota demo: guardamos kg CH4 / hora ya calculado.
CREATE TABLE ch4_emissions_hourly (
  id          SERIAL PRIMARY KEY,
  farm_id     INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  hour_ts     TIMESTAMPTZ NOT NULL,
  kg_ch4      NUMERIC(10,2) NOT NULL CHECK (kg_ch4 >= 0),
  UNIQUE (farm_id, hour_ts)
);

-- CO2eq reducido por mes (base para bonos e ingresos)
-- Reglas demo:
-- - 1 bono = 1 "unidad" mensual (aquí: 1.00 t CO2eq reducido)
-- - 1 bono equivale a $40 USD
CREATE TABLE co2eq_reduction_monthly (
  id                SERIAL PRIMARY KEY,
  farm_id           INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  month             DATE NOT NULL,             -- usa el primer día del mes
  co2eq_reduced_t   NUMERIC(10,2) NOT NULL CHECK (co2eq_reduced_t >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, month)
);

-- ─────────────────────────────────────────────────────────────
-- Seed data (alineado con el HTML + nuevas reglas)
-- ─────────────────────────────────────────────────────────────

-- Contraseña de demo: demo123 (scrypt, formato salt:hash hex)
INSERT INTO users (full_name, role, account_type, location, email, password_hash)
VALUES (
  'Carlos Hernández Muñoz',
  'Ganadero',
  'ganadero',
  'Córdoba, Colombia',
  'carlos@example.com',
  '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'
);

-- Admin demo (misma contraseña que Carlos: demo123)
INSERT INTO users (full_name, role, account_type, location, email, password_hash)
VALUES (
  'Supervisor Plataforma',
  'Administración',
  'admin',
  'Bogotá, Colombia',
  'admin@biofert.demo',
  '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'
);

-- 10 ganaderos adicionales (contraseña demo: demo123, mismo hash)
INSERT INTO users (full_name, role, account_type, location, email, password_hash) VALUES
  ('María López Vargas', 'Ganadero', 'ganadero', 'Medellín, Colombia', 'maria.lopez@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Pedro Ruiz Gómez', 'Ganadero', 'ganadero', 'Manizales, Colombia', 'pedro.ruiz@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Ana Martínez Soto', 'Ganadero', 'ganadero', 'Ibagué, Colombia', 'ana.martinez@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Luis Fernando Castro', 'Ganadero', 'ganadero', 'Villavicencio, Colombia', 'luis.castro@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Carmen Díaz Ríos', 'Ganadero', 'ganadero', 'Pasto, Colombia', 'carmen.diaz@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Jorge Salinas Peña', 'Ganadero', 'ganadero', 'Neiva, Colombia', 'jorge.salinas@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Lucía Herrera Mora', 'Ganadero', 'ganadero', 'Popayán, Colombia', 'lucia.herrera@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Diego Morales Vega', 'Ganadero', 'ganadero', 'Montería, Colombia', 'diego.morales@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Patricia Núñez Arias', 'Ganadero', 'ganadero', 'Sincelejo, Colombia', 'patricia.nunez@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c'),
  ('Ricardo Mejía Duarte', 'Ganadero', 'ganadero', 'Valledupar, Colombia', 'ricardo.mejia@example.com', '7f2c7a433f8a2d88ceade978b6aadc8a:32b8e6d76be66e4d6801462aeecf0717d7c22ae19fcc4d509e9cd2e2be134cd3821bb399253c5e6ae06aa14e2309bf4eb78051232e9822e1e158bf46442e2e2c');

UPDATE users SET account_type = 'tecnico' WHERE id = 4;

INSERT INTO farms (user_id, name, location, area_ha, heads_active, breeds_text, thermal_floor, altitude_m, production_model, certification_step)
VALUES
  (1, 'Finca El Porvenir', 'Córdoba, Colombia', 320, 280, 'Brahman 60% · Angus 40%', 'Cálido', 80, 'Doble propósito', 4),
  (1, 'Finca La Esperanza', 'Córdoba, Colombia', 120, 95, 'Cebú 70% · Criollo 30%', 'Cálido', 95, 'Cría / Levante', 3),
  (3, 'Hacienda La Palma', 'Medellín, Colombia', 180, 140, 'Jersey 50% · Holstein 50%', 'Templado', 1450, 'Leche', 2),
  (3, 'Predio San José', 'Rionegro, Colombia', 95, 72, 'Holstein', 'Templado', 2100, 'Leche', 5),
  (4, 'Finca Los Alpes', 'Manizales, Colombia', 210, 165, 'Angus', 'Frío', 2200, 'Ceba', 1),
  (5, 'El Roble', 'Ibagué, Colombia', 150, 110, 'Brahman', 'Cálido', 900, 'Doble propósito', 6),
  (6, 'Llanos del Meta', 'Villavicencio, Colombia', 400, 320, 'Cebú', 'Cálido', 450, 'Cría', 2),
  (7, 'Vereda La Vega', 'Pasto, Colombia', 88, 64, 'Normando', 'Frío', 2650, 'Leche', 3),
  (8, 'Finca El Paraíso', 'Neiva, Colombia', 260, 198, 'Brahman 60%', 'Cálido', 520, 'Ceba', 4),
  (9, 'Hacienda El Trébol', 'Popayán, Colombia', 140, 102, 'Criollo', 'Templado', 1750, 'Doble propósito', 5),
  (10, 'Los Manglares', 'Montería, Colombia', 310, 245, 'Cebú', 'Cálido', 40, 'Cría / Levante', 1),
  (11, 'San Rafael', 'Sincelejo, Colombia', 175, 130, 'Brahman', 'Cálido', 120, 'Ceba', 2),
  (12, 'La Guajira Verde', 'Valledupar, Colombia', 220, 188, 'Cebú 80%', 'Cálido', 150, 'Cría', 3);

INSERT INTO sensors (farm_id, code, zone, status, battery_pct)
VALUES
  (1, 'A1', 'Zona Norte', 'activo', 82),
  (1, 'A2', 'Zona Sur',   'alerta', 64),
  (1, 'A3', 'Corral',     'activo', 91),
  (1, 'A4', 'Bebedero',   'activo', 77),
  (1, 'A5', 'Potrero 1',  'activo', 73),
  (1, 'A6', 'Potrero 2',  'inactivo', 0),
  (2, 'B1', 'Entrada',    'activo', 88),
  (2, 'B2', 'Zona Sur',   'activo', 79),
  (2, 'B3', 'Corral',     'alerta', 52),
  (2, 'B4', 'Bebedero',   'activo', 66);

INSERT INTO sensors (farm_id, code, zone, status, battery_pct)
SELECT f.id,
  'S1',
  'Potrero central',
  CASE WHEN f.id % 5 = 0 THEN 'alerta' WHEN f.id % 7 = 0 THEN 'inactivo' ELSE 'activo' END,
  (55 + (f.id % 40))::int
FROM farms f
WHERE f.id >= 3;

-- Lecturas: varias por sensor para que se vea más real
INSERT INTO sensor_readings (sensor_id, ch4_ppm, recorded_at)
SELECT
  s.id,
  (25 + (s.id % 7) * 3 + (gs.i % 8) * 1.2 + CASE WHEN s.status = 'alerta' AND (gs.i % 6)=0 THEN 25 ELSE 0 END)::numeric(10,2) AS ch4_ppm,
  NOW() - (gs.i || ' hours')::interval + ((s.id % 10) || ' minutes')::interval
FROM sensors s
CROSS JOIN generate_series(0, 23) AS gs(i);

INSERT INTO recommendations (
  title, expected_reduction_pct, difficulty, notes,
  intervention_kind, dosage_detail, applicability_conditions, bibliographic_refs,
  local_provider, estimated_cost_cop, updated_by_user_id
) VALUES
  (
    'Suplemento 3-NOP (Bovaer®)', 25.00, 'media', '150 mg/cabeza/día',
    'aditivo',
    '60–120 mg/kg MS en concentrado; 150 mg/cabeza/día referencia para vaca lechera (validar MS ingerida).',
    'Lotes con dieta estable (TMR o concentrado diario); no mezclar con otras moléculas metanogénicas sin asesoría.',
    'Dijkstra et al. (2018) 3-NOP; Melgar et al. (2021) revisiones de mitigación ruminal.',
    'Distribuidor autorizado CO — demo regional',
    185000,
    2
  ),
  (
    'Semillas de lino en concentrado', 15.00, 'facil', NULL,
    'forraje',
    '50–200 g MS linaza/cabeza/día introducción gradual 7–10 días.',
    'Vacas y novillas con espacio en mezcladora; vigilar peroxidación del aceite.',
    'Benchaar et al. (2008) lípidos y metano ruminal.',
    'Agroinsumos del Valle (demo)',
    72000,
    2
  ),
  (
    'Rotación intensiva de potreros', 12.00, 'alta', NULL,
    'practica',
    'Tiempo de ocupación 1–3 días; descanso 21–35 días según crecimiento.',
    'Predios con subdivisión mínima 4–8 potreros; agua en cada franja.',
    'Teague et al. (2011) pastoreo planificado; CCA Colombia buenas prácticas.',
    'Asesoría local pastos (demo)',
    450000,
    2
  ),
  (
    'Taninos condensados (Acacia)', 10.00, 'media', NULL,
    'aditivo',
    'Forraje o extracto: 1–4% MS según especie; monitorear consumo.',
    'Introducción lenta; evitar en vacas recién paridas sin protocolo.',
    'Min et al. (2006) taninos y fermentación ruminal.',
    'Forrajera La Sabana (demo)',
    98000,
    2
  ),
  (
    'Mejora de calidad de forraje', 8.00, 'facil', 'Ajuste de pastoreo y suplementación mineral',
    'practica',
    'Fertilización balanceada + altura de entrada/salida documentada.',
    'Zonas templadas/cálidas con capacidad de riego o lluvia confiable.',
    'FAO (2019) buenas prácticas pastoreo; manual SENA ganadería sostenible.',
    'Cooperativa agrícola (demo)',
    55000,
    2
  ),
  (
    'Aditivos en agua (ensayo)', 5.00, 'media', 'Aplicar en lote control por 30 días',
    'aditivo',
    'Dosis según volumen de bebedero; lote test vs control.',
    'Bebederos separados por lote; registro de consumo de agua.',
    'Literatura técnica ensayos en agua (demo referencial).',
    'Veterinaria San José (demo)',
    110000,
    2
  ),
  (
    'Asparagopsis taxiformis (macroalga)', 40.00, 'media', 'Ensayo bromoformo bajo supervisión',
    'aditivo',
    'Dosis bromoformo según protocolo comercial; solo con cadena de frío.',
    'Instalaciones con mezclado homogéneo; cumplimiento normativo local.',
    'Roque et al. (2019) Asparagopsis; revisiones de seguridad alimentaria.',
    'Importador marino Pacífico (demo)',
    320000,
    2
  ),
  (
    'Sombras y bebederos estratégicos', 6.50, 'facil', 'Reduce estrés térmico y mejora eficiencia',
    'practica',
    'Cobertura ≥2.5 m²/cabeza en zona de descanso; caudal agua ≥10 L/min.',
    'Pisos térmicos cálidos; THI elevado en verano.',
    'Renaudeau et al. (2012) estrés térmico en rumiantes.',
    'Materiales ganaderos SA (demo)',
    130000,
    2
  );

INSERT INTO farm_recommendations (farm_id, recommendation_id, status, impact_review_scheduled_at, tracking_started_at)
VALUES
  (1, 1, 'en_seguimiento', NOW() + interval '14 days', NOW() - interval '3 days'),
  (1, 2, 'pendiente'),
  (1, 3, 'aplicada'),
  (1, 4, 'descartada'),
  (1, 5, 'pendiente'),
  (1, 6, 'aplicada'),
  (2, 2, 'pendiente'),
  (2, 3, 'pendiente'),
  (2, 8, 'pendiente'),
  (2, 6, 'aplicada');

-- Emisiones últimas 24h (kg CH4 / hora) para la finca 1
-- Valores demo (parecidos a una serie con variación suave)
INSERT INTO ch4_emissions_hourly (farm_id, hour_ts, kg_ch4)
SELECT
  1,
  date_trunc('hour', NOW()) - (gs.i || ' hours')::interval,
  (3.5 + (gs.i % 6) * 0.6 + CASE WHEN (gs.i % 9)=0 THEN 1.0 ELSE 0 END)::numeric(10,2)
FROM generate_series(0, 24 * 12 - 1) AS gs(i)
ON CONFLICT DO NOTHING;

-- Emisiones 24h para la finca 2 (otra forma de variación)
INSERT INTO ch4_emissions_hourly (farm_id, hour_ts, kg_ch4)
SELECT
  2,
  date_trunc('hour', NOW()) - (gs.i || ' hours')::interval,
  (1.8 + (gs.i % 5) * 0.45 + CASE WHEN (gs.i % 7)=0 THEN 0.8 ELSE 0 END)::numeric(10,2)
FROM generate_series(0, 24 * 12 - 1) AS gs(i)
ON CONFLICT DO NOTHING;

INSERT INTO ch4_emissions_hourly (farm_id, hour_ts, kg_ch4)
SELECT
  f.id,
  date_trunc('hour', NOW()) - (gs.i || ' hours')::interval,
  (1.0 + (f.id % 9) * 0.12 + (gs.i % 6) * 0.25 + CASE WHEN (gs.i + f.id) % 11 = 0 THEN 0.6 ELSE 0 END)::numeric(10,2)
FROM farms f
CROSS JOIN generate_series(0, 24 * 12 - 1) AS gs(i)
WHERE f.id BETWEEN 3 AND 13
ON CONFLICT DO NOTHING;

-- CO2eq reducido por mes (t)
INSERT INTO co2eq_reduction_monthly (farm_id, month, co2eq_reduced_t)
VALUES
  (1, DATE '2025-03-01', 0.20),
  (1, DATE '2025-04-01', 0.35),
  (1, DATE '2025-05-01', 0.55),
  (1, DATE '2025-06-01', 0.62),
  (1, DATE '2025-07-01', 0.70),
  (1, DATE '2025-08-01', 0.85),
  (1, DATE '2025-09-01', 0.40),
  (1, DATE '2025-10-01', 0.60),
  (1, DATE '2025-11-01', 0.80),
  (1, DATE '2025-12-01', 1.10),
  (1, DATE '2026-01-01', 2.10),
  (1, DATE '2026-02-01', 1.60),
  (2, DATE '2025-10-01', 0.25),
  (2, DATE '2025-11-01', 0.30),
  (2, DATE '2025-12-01', 0.45),
  (2, DATE '2026-01-01', 0.50),
  (2, DATE '2026-02-01', 0.70),
  (2, DATE '2026-03-01', 0.90);

INSERT INTO co2eq_reduction_monthly (farm_id, month, co2eq_reduced_t)
SELECT f.id, m::date, (0.08 + (f.id % 5) * 0.03 + (extract(month from m) * 0.02))::numeric(10,2)
FROM farms f
CROSS JOIN (VALUES
  (DATE '2025-11-01'), (DATE '2025-12-01'), (DATE '2026-01-01'), (DATE '2026-02-01'), (DATE '2026-03-01')
) v(m)
WHERE f.id BETWEEN 3 AND 13;

INSERT INTO farm_recommendations (farm_id, recommendation_id, status)
SELECT f.id, r.rid, CASE WHEN (f.id + r.rid) % 3 = 0 THEN 'aplicada' WHEN (f.id + r.rid) % 3 = 1 THEN 'pendiente' ELSE 'descartada' END
FROM farms f
CROSS JOIN (VALUES (1), (4)) AS r(rid)
WHERE f.id BETWEEN 3 AND 13;

INSERT INTO audit_log (user_id, action, meta, created_at)
VALUES
  (1, 'login', '{"email":"carlos@example.com"}', NOW() - interval '2 days'),
  (1, 'ver_reporte', '{}', NOW() - interval '1 day'),
  (3, 'login', '{"email":"maria.lopez@example.com"}', NOW() - interval '5 hours'),
  (4, 'login', '{}', NOW() - interval '3 days'),
  (5, 'actualizar_perfil', '{}', NOW() - interval '10 days'),
  (8, 'login', '{}', NOW() - interval '1 hour');

-- Demo CU-06: técnico (usuario 4) con lectura en finca de Carlos (1)
INSERT INTO farm_user_access (farm_id, user_id, permission_level, granted_by_user_id)
VALUES (1, 4, 'lectura', 2);

INSERT INTO intervention_feedback (
  farm_recommendation_id, user_id, production_change_pct, real_cost_cop, livestock_acceptability, observations, queued_for_model_training
)
SELECT fr.id, 1, -1.2, 175000, 'media', 'Consumo estable; monitoreo continuo en corral norte.', TRUE
FROM farm_recommendations fr
WHERE fr.farm_id = 1 AND fr.recommendation_id = 1 AND fr.status = 'en_seguimiento'
LIMIT 1;

