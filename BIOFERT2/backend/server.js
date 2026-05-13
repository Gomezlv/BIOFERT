const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  database: process.env.PGDATABASE || "metaganado",
});

/** @type {Map<string, number>} token -> userId */
const sessions = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const verify = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(verify, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

function getSessionUserId(req) {
  const h = req.headers.authorization;
  if (!h || !String(h).startsWith("Bearer ")) return null;
  const token = String(h).slice(7).trim();
  if (!token) return null;
  return sessions.get(token) ?? null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, userId);
  return token;
}

function destroySession(req) {
  const h = req.headers.authorization;
  if (!h || !String(h).startsWith("Bearer ")) return;
  const token = String(h).slice(7).trim();
  sessions.delete(token);
}

async function assertFarmOwned(farmId, userId) {
  const { rows } = await pool.query(
    `SELECT id FROM farms WHERE id = $1 AND user_id = $2 LIMIT 1;`,
    [farmId, userId]
  );
  return rows.length > 0;
}

async function assertFarmDelegated(farmId, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM farm_user_access WHERE farm_id = $1 AND user_id = $2 LIMIT 1`,
      [farmId, userId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function assertFarmExists(farmId) {
  const { rows } = await pool.query(`SELECT id FROM farms WHERE id = $1 LIMIT 1`, [farmId]);
  return rows.length > 0;
}

/** @returns {Promise<{ userId: number, isAdmin: boolean } | null>} */
async function authContext(req) {
  const userId = getSessionUserId(req);
  if (!userId) return null;
  const row = (
    await pool.query(
      `SELECT id, account_type, COALESCE(account_status, 'active') AS account_status FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    )
  ).rows[0];
  if (!row) return null;
  if (String(row.account_status || "").toLowerCase() === "suspended") return null;
  const isAdmin = String(row.account_type || "").toLowerCase() === "admin";
  return { userId: row.id, isAdmin };
}

async function assertFarmAccess(farmId, ctx) {
  if (!farmId || !ctx) return false;
  if (ctx.isAdmin) {
    return assertFarmExists(farmId);
  }
  if (await assertFarmOwned(farmId, ctx.userId)) return true;
  return assertFarmDelegated(farmId, ctx.userId);
}

async function assertFarmWriteAccess(farmId, ctx) {
  if (!farmId || !ctx) return false;
  if (ctx.isAdmin) return assertFarmExists(farmId);
  if (await assertFarmOwned(farmId, ctx.userId)) return true;
  try {
    const { rows } = await pool.query(
      `SELECT permission_level FROM farm_user_access WHERE farm_id = $1 AND user_id = $2 LIMIT 1`,
      [farmId, ctx.userId]
    );
    return rows[0]?.permission_level === "edicion";
  } catch {
    return false;
  }
}

async function ch4DistinctDayCount(farmId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT (hour_ts::date))::int AS c FROM ch4_emissions_hourly WHERE farm_id = $1`,
      [farmId]
    );
    return Number(rows[0]?.c || 0);
  } catch {
    return 0;
  }
}

function farmProfileComplete(farm) {
  if (!farm) return false;
  const loc = farm.location != null && String(farm.location).trim().length > 0;
  const breeds = farm.breeds_text != null && String(farm.breeds_text).trim().length > 0;
  const thermal = farm.thermal_floor != null && String(farm.thermal_floor).trim().length > 0;
  const model = farm.production_model != null && String(farm.production_model).trim().length > 0;
  const area = farm.area_ha != null && Number(farm.area_ha) > 0;
  const heads = Number(farm.heads_active) > 0;
  return loc && breeds && thermal && model && area && heads;
}

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

// GET /api/config (solo autenticado) — configuración cliente (ej. Google Maps)
app.get("/api/config", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
  });
});

// POST /api/auth/register
app.post("/api/auth/register", async (req, res) => {
  const { email, password, full_name, location } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email y password son obligatorios" });
  }
  const name = full_name && String(full_name).trim() ? String(full_name).trim() : "Usuario";
  const loc = location != null && String(location).trim() ? String(location).trim() : null;
  const pwdHash = hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insUser = `
      INSERT INTO users (full_name, role, account_type, account_status, location, email, password_hash)
      VALUES ($1, 'Ganadero', 'ganadero', 'active', $2, $3, $4)
      RETURNING id, full_name, role, account_type, COALESCE(account_status, 'active') AS account_status, location, email;
    `;
    let userRow;
    try {
      userRow = (await client.query(insUser, [name, loc, String(email).trim().toLowerCase(), pwdHash])).rows[0];
    } catch (e) {
      await client.query("ROLLBACK");
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "El email ya está registrado" });
      }
      throw e;
    }

    const insFarm = `
      INSERT INTO farms (user_id, name, location, area_ha, heads_active)
      VALUES ($1, 'Finca La Esperanza', $2, NULL, 0)
      RETURNING id;
    `;
    await client.query(insFarm, [userRow.id, loc]);

    await client.query("COMMIT");

    const token = createSession(userRow.id);
    res.status(201).json({ token, user: userRow });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "No se pudo registrar", detail: String(e.message || e) });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email y password son obligatorios" });
  }
  const sql = `SELECT id, full_name, role, account_type, COALESCE(account_status, 'active') AS account_status, location, email, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1;`;
  const row = (await pool.query(sql, [String(email).trim()])).rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "Credenciales incorrectas" });
  }
  if (String(row.account_status || "active").toLowerCase() === "suspended") {
    return res.status(403).json({ error: "Cuenta suspendida. Contacte al administrador." });
  }
  try {
    await pool.query(`INSERT INTO audit_log (user_id, action, meta) VALUES ($1, $2, $3)`, [
      row.id,
      "login",
      JSON.stringify({ email: row.email }),
    ]);
  } catch {
    /* tabla audit_log opcional en instalaciones antiguas */
  }
  const token = createSession(row.id);
  const { password_hash: _p, ...user } = row;
  res.json({ token, user });
});

// POST /api/auth/logout
app.post("/api/auth/logout", (req, res) => {
  destroySession(req);
  res.json({ ok: true });
});

// GET /api/profile
app.get("/api/profile", async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const userSql = `SELECT id, full_name, role, account_type, COALESCE(account_status, 'active') AS account_status, location, email, created_at FROM users WHERE id = $1 LIMIT 1;`;
  const user = (await pool.query(userSql, [userId])).rows[0] || null;
  res.json({ user });
});

// PATCH /api/profile — actualizar email y/o contraseña
app.patch("/api/profile", async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const { current_password, email, new_password } = req.body || {};
  if (!current_password) {
    return res.status(400).json({ error: "current_password es obligatorio" });
  }
  if (email == null && new_password == null) {
    return res.status(400).json({ error: "Indica nuevo email y/o new_password" });
  }

  const u = (await pool.query(`SELECT id, email, password_hash FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u || !verifyPassword(current_password, u.password_hash)) {
    return res.status(401).json({ error: "Contraseña actual incorrecta" });
  }

  const nextEmail = email != null ? String(email).trim().toLowerCase() : null;
  const nextPwd = new_password != null ? String(new_password) : null;

  if (nextPwd !== null && nextPwd.length < 6) {
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
  }

  try {
    if (nextEmail && nextEmail !== u.email) {
      await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [nextEmail, userId]);
    }
    if (nextPwd) {
      const h = hashPassword(nextPwd);
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [h, userId]);
    }
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({ error: "El email ya está en uso" });
    }
    return res.status(500).json({ error: "No se pudo actualizar", detail: String(e.message || e) });
  }

  const user = (await pool.query(`SELECT id, full_name, role, account_type, location, email FROM users WHERE id = $1`, [userId])).rows[0];
  res.json({ user });
});

// PATCH /api/profile/details — actualizar datos del usuario (nombre/rol/ubicación)
app.patch("/api/profile/details", async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const { full_name, role, location, account_type: _ignoreAccount } = req.body || {};
  const name = full_name != null ? String(full_name).trim() : null;
  const r = role != null ? String(role).trim() : null;
  const loc = location != null ? String(location).trim() : null;

  if (!name) return res.status(400).json({ error: "full_name es obligatorio" });
  if (!r) return res.status(400).json({ error: "role es obligatorio" });

  try {
    await pool.query(`UPDATE users SET full_name = $1, role = $2, location = $3 WHERE id = $4`, [name, r, loc || null, userId]);
    const user = (await pool.query(`SELECT id, full_name, role, account_type, location, email, created_at FROM users WHERE id = $1`, [userId])).rows[0];
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: "No se pudo actualizar el perfil", detail: String(e.message || e) });
  }
});

// GET /api/farms — predios propios + acceso delegado (CU-06)
app.get("/api/farms", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const sql = `
    SELECT * FROM (
      SELECT id, user_id, name, location, area_ha, heads_active, breeds_text, thermal_floor, altitude_m, production_model, certification_step
      FROM farms
      WHERE user_id = $1
      UNION
      SELECT f.id, f.user_id, f.name, f.location, f.area_ha, f.heads_active, f.breeds_text, f.thermal_floor, f.altitude_m, f.production_model, f.certification_step
      FROM farms f
      INNER JOIN farm_user_access a ON a.farm_id = f.id AND a.user_id = $1
    ) t
    ORDER BY t.id ASC;
  `;
  try {
    const { rows } = await pool.query(sql, [ctx.userId]);
    res.json(rows);
  } catch {
    const sql2 = `
      SELECT id, user_id, name, location, area_ha, heads_active, breeds_text, thermal_floor, altitude_m, production_model, certification_step
      FROM farms
      WHERE user_id = $1
      ORDER BY id ASC;
    `;
    const { rows } = await pool.query(sql2, [ctx.userId]);
    res.json(rows);
  }
});

// PATCH /api/farms/:id — actualizar datos del predio
app.patch("/api/farms/:id", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });

  const farmId = Number(req.params.id || 0);
  if (!farmId || !(await assertFarmWriteAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida o sin permiso de edición" });
  }

  const {
    name,
    location,
    area_ha,
    heads_active,
    breeds_text,
    thermal_floor,
    altitude_m,
    production_model,
  } = req.body || {};

  const nextName = name != null ? String(name).trim() : null;
  if (!nextName) return res.status(400).json({ error: "name es obligatorio" });

  const nextLocation = location != null ? String(location).trim() : null;
  const nextBreeds = breeds_text != null ? String(breeds_text).trim() : null;
  const nextThermal = thermal_floor != null ? String(thermal_floor).trim() : null;
  const nextModel = production_model != null ? String(production_model).trim() : null;
  const nextArea = area_ha != null && area_ha !== "" ? Number(area_ha) : null;
  const nextHeads = heads_active != null && heads_active !== "" ? Number(heads_active) : null;
  const nextAlt = altitude_m != null && altitude_m !== "" ? Number(altitude_m) : null;

  if (nextArea !== null && Number.isNaN(nextArea)) return res.status(400).json({ error: "area_ha inválida" });
  if (nextHeads !== null && (Number.isNaN(nextHeads) || nextHeads < 0)) return res.status(400).json({ error: "heads_active inválido" });
  if (nextAlt !== null && (Number.isNaN(nextAlt) || nextAlt < 0)) return res.status(400).json({ error: "altitude_m inválido" });

  try {
    const sql = `
      UPDATE farms
      SET
        name = $1,
        location = $2,
        area_ha = $3,
        heads_active = COALESCE($4, heads_active),
        breeds_text = $5,
        thermal_floor = $6,
        altitude_m = $7,
        production_model = $8
      WHERE id = $9
      RETURNING id, user_id, name, location, area_ha, heads_active, breeds_text, thermal_floor, altitude_m, production_model, certification_step;
    `;
    const row = (await pool.query(sql, [nextName, nextLocation || null, nextArea, nextHeads, nextBreeds || null, nextThermal || null, nextAlt, nextModel || null, farmId])).rows[0];
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "No se pudo actualizar la finca", detail: String(e.message || e) });
  }
});

// GET /api/dashboard?farmId=1
app.get("/api/dashboard", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const farmId = Number(req.query.farmId || 0);
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
  }

  const farmSql = `SELECT id, heads_active FROM farms WHERE id = $1;`;
  const farm = (await pool.query(farmSql, [farmId])).rows[0];

  const alertSql = `
    SELECT
      s.code,
      s.zone,
      r.ch4_ppm,
      r.recorded_at
    FROM sensors s
    LEFT JOIN LATERAL (
      SELECT ch4_ppm, recorded_at
      FROM sensor_readings
      WHERE sensor_id = s.id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) r ON true
    WHERE s.farm_id = $1
      AND s.status = 'alerta'
    ORDER BY COALESCE(r.ch4_ppm, 0) DESC
    LIMIT 1;
  `;
  const alertSensor = (await pool.query(alertSql, [farmId])).rows[0] || null;

  const emissionsTodaySql = `
    SELECT COALESCE(SUM(kg_ch4), 0)::numeric(10,2) AS kg_today
    FROM ch4_emissions_hourly
    WHERE farm_id = $1
      AND hour_ts >= date_trunc('day', NOW());
  `;
  const emissionsToday = (await pool.query(emissionsTodaySql, [farmId])).rows[0]?.kg_today ?? 0;

  const last24Sql = `
    SELECT hour_ts, kg_ch4
    FROM ch4_emissions_hourly
    WHERE farm_id = $1
      AND hour_ts >= date_trunc('hour', NOW()) - interval '23 hours'
    ORDER BY hour_ts ASC;
  `;
  const emissions24h = (await pool.query(last24Sql, [farmId])).rows;

  const monthSumSql = `
    SELECT COALESCE(SUM(co2eq_reduced_t), 0)::numeric(10,2) AS t_month
    FROM co2eq_reduction_monthly
    WHERE farm_id = $1
      AND month = date_trunc('month', NOW())::date;
  `;
  const tMonth = (await pool.query(monthSumSql, [farmId])).rows[0]?.t_month ?? 0;

  const reductionMonthPct = Math.min((Number(tMonth) / 10) * 100, 50);

  const bondsEstimated = Math.floor(Number(tMonth));
  const bondsEstimatedUsd = bondsEstimated * 40;

  const recDaySql = `
    SELECT
      r.title,
      r.expected_reduction_pct,
      r.difficulty,
      r.notes,
      fr.status
    FROM farm_recommendations fr
    JOIN recommendations r ON r.id = fr.recommendation_id
    WHERE fr.farm_id = $1
    ORDER BY
      (CASE WHEN fr.status IN ('pendiente', 'en_seguimiento') THEN 0 ELSE 1 END) ASC,
      fr.created_at DESC
    LIMIT 1;
  `;
  const recDay = (await pool.query(recDaySql, [farmId])).rows[0] || null;

  res.json({
    farmId,
    alertSensor: alertSensor
      ? {
          code: alertSensor.code,
          zone: alertSensor.zone,
          ch4_ppm: alertSensor.ch4_ppm !== null ? Number(alertSensor.ch4_ppm) : null,
          recorded_at: alertSensor.recorded_at,
          threshold_ppm: 50,
        }
      : null,
    recommendationDay: recDay
      ? {
          title: recDay.title,
          notes: recDay.notes,
          expected_reduction_pct: recDay.expected_reduction_pct !== null ? Number(recDay.expected_reduction_pct) : null,
        }
      : null,
    emissionsTodayKg: Number(emissionsToday),
    headsActive: Number(farm?.heads_active ?? 0),
    reductionMonthPct: Number(reductionMonthPct.toFixed(1)),
    bondsEstimatedUsd,
    emissions24h: emissions24h.map(r => ({ hour_ts: r.hour_ts, kg_ch4: Number(r.kg_ch4) })),
  });
});

// GET /api/reports?farmId=1
app.get("/api/reports", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const farmId = Number(req.query.farmId || 0);
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
  }

  const totalSql = `
    SELECT COALESCE(SUM(co2eq_reduced_t), 0)::numeric(10,2) AS co2eq_total_t
    FROM co2eq_reduction_monthly
    WHERE farm_id = $1;
  `;
  const co2eqTotalT = (await pool.query(totalSql, [farmId])).rows[0]?.co2eq_total_t ?? 0;

  const byMonthSql = `
    SELECT month, co2eq_reduced_t
    FROM co2eq_reduction_monthly
    WHERE farm_id = $1
    ORDER BY month ASC;
  `;
  const byMonth = (await pool.query(byMonthSql, [farmId])).rows;

  const bonos = Math.floor(Number(co2eqTotalT));
  const valorEstimadoUsd = bonos * 40;

  res.json({
    farmId,
    co2eqReducedT: Number(co2eqTotalT),
    bondsCount: bonos,
    valueEstimatedUsd: valorEstimadoUsd,
    revenueAccumUsd: valorEstimadoUsd,
    co2eqByMonth: byMonth.map(r => ({ month: r.month, co2eq_reduced_t: Number(r.co2eq_reduced_t) })),
  });
});

// GET /api/sensors?farmId=1
app.get("/api/sensors", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const farmId = Number(req.query.farmId || 0);
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
  }

  const sql = `
    SELECT
      s.id, s.farm_id, s.code, s.zone, s.status, s.battery_pct,
      r.ch4_ppm AS last_ch4_ppm,
      r.recorded_at AS last_recorded_at
    FROM sensors s
    LEFT JOIN LATERAL (
      SELECT ch4_ppm, recorded_at
      FROM sensor_readings
      WHERE sensor_id = s.id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) r ON true
    WHERE s.farm_id = $1
    ORDER BY s.code ASC;
  `;

  const { rows } = await pool.query(sql, [farmId]);
  res.json(rows);
});

// POST /api/sensors
app.post("/api/sensors", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const { farm_id, code, zone, status = "activo", battery_pct = 100 } = req.body || {};
  const farmId = Number(farm_id || 0);
  if (!farmId || !(await assertFarmWriteAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida o sin permiso de edición" });
  }

  if (!code || !zone) {
    return res.status(400).json({ error: "code y zone son obligatorios" });
  }

  const sql = `
    INSERT INTO sensors (farm_id, code, zone, status, battery_pct)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;

  const { rows } = await pool.query(sql, [farmId, code, zone, status, battery_pct]);
  res.status(201).json(rows[0]);
});

// GET /api/recommendations?farmId=1
app.get("/api/recommendations", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const farmId = Number(req.query.farmId || 0);
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
  }

  const sql = `
    SELECT
      fr.id AS farm_rec_id,
      fr.farm_id,
      fr.status,
      fr.created_at,
      fr.decided_at,
      fr.impact_review_scheduled_at,
      fr.tracking_started_at,
      r.id AS recommendation_id,
      r.title,
      r.expected_reduction_pct,
      r.difficulty,
      r.notes,
      r.intervention_kind,
      r.dosage_detail,
      r.applicability_conditions,
      r.bibliographic_refs,
      r.local_provider,
      r.estimated_cost_cop,
      r.updated_at AS catalog_updated_at,
      r.updated_by_user_id
    FROM farm_recommendations fr
    JOIN recommendations r ON r.id = fr.recommendation_id
    WHERE fr.farm_id = $1
    ORDER BY fr.created_at DESC;
  `;

  const { rows } = await pool.query(sql, [farmId]);
  res.json(rows);
});

// POST /api/recommendations
app.post("/api/recommendations", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const {
    farm_id,
    title,
    expected_reduction_pct = null,
    difficulty = "media",
    notes = null,
  } = req.body || {};

  const farmId = Number(farm_id || 0);
  if (!farmId || !(await assertFarmWriteAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida o sin permiso de edición" });
  }

  if (!title) {
    return res.status(400).json({ error: "title es obligatorio" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insRec = `
      INSERT INTO recommendations (title, expected_reduction_pct, difficulty, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const rec = (await client.query(insRec, [title, expected_reduction_pct, difficulty, notes])).rows[0];

    const insFarmRec = `
      INSERT INTO farm_recommendations (farm_id, recommendation_id, status)
      VALUES ($1, $2, 'pendiente')
      RETURNING *;
    `;
    const farmRec = (await client.query(insFarmRec, [farmId, rec.id])).rows[0];

    await client.query("COMMIT");
    res.status(201).json({ ...farmRec, recommendation: rec });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "No se pudo crear la recomendación", detail: String(e.message || e) });
  } finally {
    client.release();
  }
});

function maskApiKey(key) {
  const s = key != null ? String(key) : "";
  if (!s) return null;
  if (s.length <= 10) return "••••";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// ─── Rutas administración (solo account_type = admin) ───

app.get("/api/admin/overview", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  try {
    const q = `
      SELECT
        (SELECT COUNT(*)::int FROM users) AS user_count,
        (SELECT COUNT(*)::int FROM users WHERE account_type = 'ganadero') AS ganadero_count,
        (SELECT COUNT(*)::int FROM users WHERE account_type = 'admin') AS admin_count,
        (SELECT COUNT(*)::int FROM farms) AS farm_count,
        (SELECT COUNT(*)::int FROM sensors) AS sensor_count,
        (SELECT COUNT(*)::int FROM sensors WHERE status = 'alerta') AS sensors_alerta,
        (SELECT COUNT(*)::int FROM farm_recommendations WHERE status = 'pendiente') AS recs_pendientes;
    `;
    const row = (await pool.query(q)).rows[0];
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "No se pudo cargar el resumen", detail: String(e.message || e) });
  }
});

app.get("/api/admin/users", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const sql = `
    SELECT u.id, u.full_name, u.role, u.account_type, COALESCE(u.account_status, 'active') AS account_status, u.email, u.location, u.created_at,
      (SELECT COUNT(*)::int FROM farms f WHERE f.user_id = u.id) AS farm_count
    FROM users u
    ORDER BY u.id ASC;
  `;
  const { rows } = await pool.query(sql);
  res.json(rows);
});

app.get("/api/admin/farms", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const sql = `
    SELECT f.id, f.user_id, f.name, f.location, f.area_ha, f.heads_active,
      f.breeds_text, f.thermal_floor, f.altitude_m, f.production_model, f.certification_step, f.created_at,
      u.email AS owner_email, u.full_name AS owner_name
    FROM farms f
    JOIN users u ON u.id = f.user_id
    ORDER BY f.id ASC;
  `;
  const { rows } = await pool.query(sql);
  res.json(rows);
});

app.get("/api/admin/users/:userId/farms", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const userId = Number(req.params.userId || 0);
  if (!userId) return res.status(400).json({ error: "Usuario inválido" });
  const sql = `
    SELECT id, user_id, name, location, area_ha, heads_active, breeds_text, thermal_floor, altitude_m, production_model, certification_step
    FROM farms
    WHERE user_id = $1
    ORDER BY id ASC;
  `;
  const { rows } = await pool.query(sql, [userId]);
  res.json(rows);
});

app.get("/api/admin/users/:userId/impact", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const userId = Number(req.params.userId || 0);
  if (!userId) return res.status(400).json({ error: "Usuario inválido" });
  const monthlySql = `
    SELECT m.month::text AS month, SUM(m.co2eq_reduced_t)::numeric(12,2) AS co2eq_reduced_t
    FROM co2eq_reduction_monthly m
    JOIN farms f ON f.id = m.farm_id
    WHERE f.user_id = $1
    GROUP BY m.month
    ORDER BY m.month ASC;
  `;
  const { rows: months } = await pool.query(monthlySql, [userId]);
  const totalCo2 = months.reduce((a, r) => a + Number(r.co2eq_reduced_t || 0), 0);
  const bonds = Math.floor(totalCo2);
  res.json({
    user_id: userId,
    co2eq_by_month: months.map(r => ({
      month: r.month,
      co2eq_reduced_t: Number(r.co2eq_reduced_t),
      ch4_eq_reduced_kg: Number((Number(r.co2eq_reduced_t) * 28).toFixed(2)),
    })),
    totals: {
      co2eq_reduced_t: totalCo2,
      bonds_count: bonds,
      value_estimated_usd: bonds * 40,
    },
  });
});

app.get("/api/admin/users/:userId/audit-log", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const userId = Number(req.params.userId || 0);
  if (!userId) return res.status(400).json({ error: "Usuario inválido" });
  try {
    const { rows } = await pool.query(
      `SELECT id, action, meta, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.patch("/api/admin/users/:userId", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const targetId = Number(req.params.userId || 0);
  if (!targetId) return res.status(400).json({ error: "Usuario inválido" });
  const { full_name, role, location, email, account_type, new_password, account_status } = req.body || {};
  const urow = (await pool.query(`SELECT id, account_type FROM users WHERE id = $1`, [targetId])).rows[0];
  if (!urow) return res.status(404).json({ error: "Usuario no encontrado" });

  const nextName = full_name != null ? String(full_name).trim() : null;
  const nextRole = role != null ? String(role).trim() : null;
  const nextLoc = location !== undefined ? (location != null && String(location).trim() ? String(location).trim() : null) : undefined;
  const nextEmail = email != null ? String(email).trim().toLowerCase() : null;
  const nextType = account_type != null ? String(account_type).toLowerCase() : null;
  const nextStatus = account_status != null ? String(account_status).toLowerCase() : null;
  const pwd = new_password != null ? String(new_password) : null;

  if (pwd && pwd.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  if (nextType && !["admin", "ganadero", "tecnico", "veterinario"].includes(nextType)) {
    return res.status(400).json({ error: "account_type inválido" });
  }
  if (nextStatus && !["active", "suspended"].includes(nextStatus)) {
    return res.status(400).json({ error: "account_status inválido" });
  }
  if (nextStatus === "suspended" && targetId === ctx.userId) {
    return res.status(400).json({ error: "No puede suspender su propia cuenta" });
  }
  if (nextType === "ganadero" && urow.account_type === "admin") {
    const { rows: ac } = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE account_type = 'admin'`);
    if (Number(ac[0]?.c) <= 1) {
      return res.status(400).json({ error: "No se puede quitar el único administrador" });
    }
  }

  try {
    const sets = [];
    const vals = [];
    let i = 1;
    if (nextName) {
      sets.push(`full_name = $${i++}`);
      vals.push(nextName);
    }
    if (nextRole) {
      sets.push(`role = $${i++}`);
      vals.push(nextRole);
    }
    if (nextLoc !== undefined) {
      sets.push(`location = $${i++}`);
      vals.push(nextLoc);
    }
    if (nextEmail) {
      sets.push(`email = $${i++}`);
      vals.push(nextEmail);
    }
    if (nextType) {
      sets.push(`account_type = $${i++}`);
      vals.push(nextType);
    }
    if (pwd) {
      sets.push(`password_hash = $${i++}`);
      vals.push(hashPassword(pwd));
    }
    if (nextStatus) {
      sets.push(`account_status = $${i++}`);
      vals.push(nextStatus);
    }
    if (sets.length === 0) return res.status(400).json({ error: "Sin cambios" });
    vals.push(targetId);
    await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    const user = (
      await pool.query(
        `SELECT id, full_name, role, account_type, COALESCE(account_status, 'active') AS account_status, location, email, created_at FROM users WHERE id = $1`,
        [targetId]
      )
    ).rows[0];
    res.json({ user });
  } catch (e) {
    if (e && e.code === "23505") return res.status(409).json({ error: "El email ya está en uso" });
    res.status(500).json({ error: "No se pudo actualizar", detail: String(e.message || e) });
  }
});

app.delete("/api/admin/users/:userId", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const targetId = Number(req.params.userId || 0);
  if (!targetId) return res.status(400).json({ error: "Usuario inválido" });
  if (targetId === ctx.userId) return res.status(400).json({ error: "No puedes eliminar tu propia cuenta" });
  const urow = (await pool.query(`SELECT account_type FROM users WHERE id = $1`, [targetId])).rows[0];
  if (!urow) return res.status(404).json({ error: "Usuario no encontrado" });
  if (urow.account_type === "admin") {
    const { rows: ac } = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE account_type = 'admin'`);
    if (Number(ac[0]?.c) <= 1) return res.status(400).json({ error: "No se puede eliminar el único administrador" });
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [targetId]);
  res.json({ ok: true });
});

app.get("/api/admin/sensors", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const sql = `
    SELECT
      s.id, s.farm_id, s.code, s.zone, s.status, s.battery_pct, s.installed_at,
      f.name AS farm_name,
      u.id AS owner_user_id, u.email AS owner_email,
      r.ch4_ppm AS last_ch4_ppm,
      r.recorded_at AS last_recorded_at
    FROM sensors s
    JOIN farms f ON f.id = s.farm_id
    JOIN users u ON u.id = f.user_id
    LEFT JOIN LATERAL (
      SELECT ch4_ppm, recorded_at
      FROM sensor_readings
      WHERE sensor_id = s.id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) r ON true
    ORDER BY s.id ASC;
  `;
  const { rows } = await pool.query(sql);
  res.json(rows);
});

app.get("/api/admin/farm-recommendations", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const sql = `
    SELECT
      fr.id AS farm_rec_id,
      fr.farm_id,
      fr.status,
      fr.created_at,
      fr.decided_at,
      fr.impact_review_scheduled_at,
      fr.tracking_started_at,
      r.id AS recommendation_id,
      r.title,
      r.expected_reduction_pct,
      r.difficulty,
      r.notes,
      f.name AS farm_name,
      u.email AS owner_email
    FROM farm_recommendations fr
    JOIN recommendations r ON r.id = fr.recommendation_id
    JOIN farms f ON f.id = fr.farm_id
    JOIN users u ON u.id = f.user_id
    ORDER BY fr.created_at DESC;
  `;
  const { rows } = await pool.query(sql);
  res.json(rows);
});

app.get("/api/admin/reports-summary", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const sql = `
    SELECT f.id AS farm_id, f.name AS farm_name, f.certification_step,
      COALESCE(SUM(m.co2eq_reduced_t), 0)::numeric(12,2) AS co2eq_reduced_t
    FROM farms f
    LEFT JOIN co2eq_reduction_monthly m ON m.farm_id = f.id
    GROUP BY f.id, f.name, f.certification_step
    ORDER BY f.id ASC;
  `;
  const { rows } = await pool.query(sql);
  const certLabels = ["Medición", "Análisis", "Reporte", "Auditoría externa", "Certificación", "Pago / monetización"];
  const byFarm = rows.map(r => ({
    farm_id: r.farm_id,
    farm_name: r.farm_name,
    certification_step: Number(r.certification_step || 1),
    certification_label: certLabels[Math.min(Math.max(Number(r.certification_step || 1), 1), 6) - 1],
    co2eq_reduced_t: Number(r.co2eq_reduced_t),
    bonds_count: Math.floor(Number(r.co2eq_reduced_t)),
    value_estimated_usd: Math.floor(Number(r.co2eq_reduced_t)) * 40,
  }));
  const totalCo2eq = byFarm.reduce((a, b) => a + b.co2eq_reduced_t, 0);
  res.json({
    total_co2eq_reduced_t: totalCo2eq,
    total_bonds_usd: Math.floor(totalCo2eq) * 40,
    byFarm,
  });
});

app.get("/api/admin/audit", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.user_id, a.action, a.meta, a.created_at, u.email AS user_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.get("/api/admin/config-summary", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  res.json({
    googleMapsApiKeyMasked: maskApiKey(process.env.GOOGLE_MAPS_API_KEY || ""),
    port: PORT,
    database: process.env.PGDATABASE || "metaganado",
  });
});

// ─── CU-03: recomendaciones dietéticas priorizadas + precondiciones ───
app.get("/api/dietary-recommendations", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  const farmId = Number(req.query.farmId || 0);
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
  }
  const farmSql = `SELECT * FROM farms WHERE id = $1 LIMIT 1`;
  const farm = (await pool.query(farmSql, [farmId])).rows[0] || null;
  const ch4Days = await ch4DistinctDayCount(farmId);
  const profileOk = farmProfileComplete(farm);
  const eligible = ch4Days >= 7 && profileOk;
  const reasons = [];
  if (ch4Days < 7) reasons.push(`Historial CH₄ insuficiente: ${ch4Days} día(s) distintos con datos; se requieren ≥7.`);
  if (!profileOk) reasons.push("Complete el perfil del predio (ubicación, área, cabezas >0, razas, piso térmico, modelo productivo).");

  const itemsSql = `
    SELECT
      r.id AS recommendation_id,
      r.title,
      r.expected_reduction_pct,
      r.difficulty,
      r.notes,
      r.intervention_kind,
      r.dosage_detail,
      r.applicability_conditions,
      r.bibliographic_refs,
      r.local_provider,
      r.estimated_cost_cop,
      r.updated_at AS catalog_updated_at,
      r.updated_by_user_id,
      fr.id AS farm_rec_id,
      fr.status AS farm_status,
      fr.impact_review_scheduled_at,
      fr.tracking_started_at
    FROM recommendations r
    LEFT JOIN farm_recommendations fr ON fr.recommendation_id = r.id AND fr.farm_id = $1
    ORDER BY r.expected_reduction_pct DESC NULLS LAST, r.id ASC;
  `;
  const { rows: items } = await pool.query(itemsSql, [farmId]);
  res.json({
    farmId,
    eligible,
    preconditions: { ch4_distinct_days: ch4Days, profile_complete: profileOk },
    reasons,
    impact_review_days_default: 14,
    items: items.map(x => ({
      recommendation_id: x.recommendation_id,
      title: x.title,
      expected_reduction_pct: x.expected_reduction_pct != null ? Number(x.expected_reduction_pct) : null,
      difficulty: x.difficulty,
      notes: x.notes,
      intervention_kind: x.intervention_kind,
      dosage_detail: x.dosage_detail,
      applicability_conditions: x.applicability_conditions,
      bibliographic_refs: x.bibliographic_refs,
      local_provider: x.local_provider,
      estimated_cost_cop: x.estimated_cost_cop != null ? Number(x.estimated_cost_cop) : null,
      catalog_updated_at: x.catalog_updated_at,
      updated_by_user_id: x.updated_by_user_id,
      farm_rec_id: x.farm_rec_id,
      farm_status: x.farm_status,
      impact_review_scheduled_at: x.impact_review_scheduled_at,
      tracking_started_at: x.tracking_started_at,
    })),
  });
});

// Adoptar intervención del catálogo en el predio (crea vínculo pendiente)
app.post("/api/farms/:farmId/recommendations/adopt", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  const farmId = Number(req.params.farmId || 0);
  const { recommendation_id } = req.body || {};
  const recId = Number(recommendation_id || 0);
  if (!farmId || !recId || !(await assertFarmWriteAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida o sin permiso de edición" });
  }
  const ch4Days = await ch4DistinctDayCount(farmId);
  const farm = (await pool.query(`SELECT * FROM farms WHERE id = $1`, [farmId])).rows[0];
  if (ch4Days < 7 || !farmProfileComplete(farm)) {
    return res.status(412).json({ error: "No se cumplen las precondiciones (CH₄ ≥7 días y perfil de predio completo)." });
  }
  try {
    const ins = await pool.query(
      `INSERT INTO farm_recommendations (farm_id, recommendation_id, status)
       VALUES ($1, $2, 'pendiente')
       ON CONFLICT (farm_id, recommendation_id) DO NOTHING
       RETURNING id, farm_id, recommendation_id, status, created_at, impact_review_scheduled_at, tracking_started_at`,
      [farmId, recId]
    );
    if (ins.rows[0]) {
      return res.status(201).json(ins.rows[0]);
    }
    const ex = await pool.query(
      `SELECT id, farm_id, recommendation_id, status, created_at, impact_review_scheduled_at, tracking_started_at
       FROM farm_recommendations WHERE farm_id = $1 AND recommendation_id = $2`,
      [farmId, recId]
    );
    if (!ex.rows[0]) {
      return res.status(500).json({ error: "No se pudo crear ni recuperar el vínculo finca–intervención" });
    }
    return res.status(200).json(ex.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "No se pudo vincular la intervención", detail: String(e.message || e) });
  }
});

// CU-03: activar seguimiento de una intervención ya vinculada al predio
app.post("/api/farms/:farmId/recommendations/:farmRecId/activate-tracking", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  const farmId = Number(req.params.farmId || 0);
  const farmRecId = Number(req.params.farmRecId || 0);
  if (!farmId || !farmRecId || !(await assertFarmWriteAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida o sin permiso de edición" });
  }
  const ch4Days = await ch4DistinctDayCount(farmId);
  const farm = (await pool.query(`SELECT * FROM farms WHERE id = $1`, [farmId])).rows[0];
  if (ch4Days < 7 || !farmProfileComplete(farm)) {
    return res.status(412).json({ error: "No se cumplen las precondiciones (CH₄ ≥7 días y perfil de predio completo)." });
  }
  const sql = `
    UPDATE farm_recommendations
    SET
      status = 'en_seguimiento',
      tracking_started_at = COALESCE(tracking_started_at, NOW()),
      impact_review_scheduled_at = NOW() + interval '14 days',
      decided_at = COALESCE(decided_at, NOW())
    WHERE id = $1 AND farm_id = $2 AND status IN ('pendiente', 'aplicada')
    RETURNING *;
  `;
  const row = (await pool.query(sql, [farmRecId, farmId])).rows[0];
  if (!row) {
    return res.status(400).json({ error: "No se puede activar seguimiento (estado no válido o registro inexistente)." });
  }
  try {
    await pool.query(`INSERT INTO audit_log (user_id, action, meta) VALUES ($1, $2, $3)`, [
      ctx.userId,
      "activar_seguimiento_intervencion",
      JSON.stringify({ farm_id: farmId, farm_recommendation_id: farmRecId }),
    ]);
  } catch {
    /* opcional */
  }
  res.json({
    farm_recommendation: row,
    message: "Seguimiento activo. Revisión automática de impacto programada a 14 días.",
  });
});

// CU-05: retroalimentación (intervención en seguimiento)
app.post("/api/farms/:farmId/recommendations/:farmRecId/feedback", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  const farmId = Number(req.params.farmId || 0);
  const farmRecId = Number(req.params.farmRecId || 0);
  if (!farmId || !farmRecId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
  }
  const fr = (await pool.query(`SELECT id, status FROM farm_recommendations WHERE id = $1 AND farm_id = $2`, [farmRecId, farmId])).rows[0];
  if (!fr || fr.status !== "en_seguimiento") {
    return res.status(412).json({ error: "Solo se registra retroalimentación con intervención en estado «en seguimiento»." });
  }
  const { production_change_pct, real_cost_cop, livestock_acceptability, observations } = req.body || {};
  const acc = livestock_acceptability != null ? String(livestock_acceptability).toLowerCase() : "";
  if (!["baja", "media", "alta"].includes(acc)) {
    return res.status(400).json({ error: "livestock_acceptability debe ser baja, media o alta" });
  }
  const prodPct = production_change_pct != null && production_change_pct !== "" ? Number(production_change_pct) : null;
  const cost = real_cost_cop != null && real_cost_cop !== "" ? Number(real_cost_cop) : null;
  if (prodPct != null && Number.isNaN(prodPct)) return res.status(400).json({ error: "production_change_pct inválido" });
  if (cost != null && Number.isNaN(cost)) return res.status(400).json({ error: "real_cost_cop inválido" });
  const obs = observations != null ? String(observations).trim() : null;
  try {
    const ins = `
      INSERT INTO intervention_feedback (
        farm_recommendation_id, user_id, production_change_pct, real_cost_cop, livestock_acceptability, observations, queued_for_model_training
      ) VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      RETURNING *;
    `;
    const fb = (await pool.query(ins, [farmRecId, ctx.userId, prodPct, cost, acc, obs || null])).rows[0];
    await pool.query(`INSERT INTO audit_log (user_id, action, meta) VALUES ($1, $2, $3)`, [
      ctx.userId,
      "retroalimentacion_intervencion",
      JSON.stringify({ farm_id: farmId, farm_recommendation_id: farmRecId, feedback_id: fb.id }),
    ]);
    res.status(201).json({
      feedback: fb,
      model_training_note: "Retroalimentación almacenada; el modelo de recomendaciones se actualizará en el próximo ciclo de entrenamiento.",
    });
  } catch (e) {
    res.status(500).json({ error: "No se pudo guardar la retroalimentación", detail: String(e.message || e) });
  }
});

// ─── CU-07: catálogo científico (admin; técnico/veterinario pueden leer vía mismo endpoint si se amplía) ───
app.get("/api/admin/intervention-catalog", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const { rows } = await pool.query(
    `SELECT r.*, u.full_name AS updated_by_name, u.email AS updated_by_email
     FROM recommendations r
     LEFT JOIN users u ON u.id = r.updated_by_user_id
     ORDER BY r.id ASC`
  );
  res.json(rows);
});

app.post("/api/admin/intervention-catalog", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const b = req.body || {};
  const title = b.title != null ? String(b.title).trim() : "";
  if (!title) return res.status(400).json({ error: "title es obligatorio" });
  const difficulty = b.difficulty != null ? String(b.difficulty).toLowerCase() : "media";
  if (!["facil", "media", "alta"].includes(difficulty)) return res.status(400).json({ error: "difficulty inválida" });
  const kind = b.intervention_kind != null ? String(b.intervention_kind).toLowerCase() : null;
  if (kind && !["aditivo", "forraje", "practica"].includes(kind)) return res.status(400).json({ error: "intervention_kind inválido" });
  const sql = `
    INSERT INTO recommendations (
      title, expected_reduction_pct, difficulty, notes,
      intervention_kind, dosage_detail, applicability_conditions, bibliographic_refs,
      local_provider, estimated_cost_cop, updated_by_user_id, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    RETURNING *;
  `;
  const vals = [
    title,
    b.expected_reduction_pct != null && b.expected_reduction_pct !== "" ? Number(b.expected_reduction_pct) : null,
    difficulty,
    b.notes != null ? String(b.notes) : null,
    kind,
    b.dosage_detail != null ? String(b.dosage_detail) : null,
    b.applicability_conditions != null ? String(b.applicability_conditions) : null,
    b.bibliographic_refs != null ? String(b.bibliographic_refs) : null,
    b.local_provider != null ? String(b.local_provider) : null,
    b.estimated_cost_cop != null && b.estimated_cost_cop !== "" ? Number(b.estimated_cost_cop) : null,
    ctx.userId,
  ];
  try {
    const row = (await pool.query(sql, vals)).rows[0];
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: "No se pudo crear la entrada", detail: String(e.message || e) });
  }
});

app.patch("/api/admin/intervention-catalog/:id", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: "ID inválido" });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  const push = (col, val) => {
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  };
  if (b.title != null) push("title", String(b.title).trim());
  if (b.expected_reduction_pct !== undefined)
    push("expected_reduction_pct", b.expected_reduction_pct === null || b.expected_reduction_pct === "" ? null : Number(b.expected_reduction_pct));
  if (b.difficulty != null) {
    const d = String(b.difficulty).toLowerCase();
    if (!["facil", "media", "alta"].includes(d)) return res.status(400).json({ error: "difficulty inválida" });
    push("difficulty", d);
  }
  if (b.notes !== undefined) push("notes", b.notes == null ? null : String(b.notes));
  if (b.intervention_kind !== undefined) {
    const k = b.intervention_kind == null ? null : String(b.intervention_kind).toLowerCase();
    if (k && !["aditivo", "forraje", "practica"].includes(k)) return res.status(400).json({ error: "intervention_kind inválido" });
    push("intervention_kind", k);
  }
  if (b.dosage_detail !== undefined) push("dosage_detail", b.dosage_detail == null ? null : String(b.dosage_detail));
  if (b.applicability_conditions !== undefined)
    push("applicability_conditions", b.applicability_conditions == null ? null : String(b.applicability_conditions));
  if (b.bibliographic_refs !== undefined) push("bibliographic_refs", b.bibliographic_refs == null ? null : String(b.bibliographic_refs));
  if (b.local_provider !== undefined) push("local_provider", b.local_provider == null ? null : String(b.local_provider));
  if (b.estimated_cost_cop !== undefined)
    push("estimated_cost_cop", b.estimated_cost_cop === null || b.estimated_cost_cop === "" ? null : Number(b.estimated_cost_cop));
  if (sets.length === 0) return res.status(400).json({ error: "Sin cambios" });
  push("updated_by_user_id", ctx.userId);
  push("updated_at", new Date());
  vals.push(id);
  const sql = `UPDATE recommendations SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`;
  const row = (await pool.query(sql, vals)).rows[0];
  if (!row) return res.status(404).json({ error: "No encontrado" });
  res.json(row);
});

// ─── CU-06: usuarios adicionales, suspensión, predios y accesos ───
app.post("/api/admin/users", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const { email, password, full_name, role, location, account_type } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email y password son obligatorios" });
  const at = account_type != null ? String(account_type).toLowerCase() : "ganadero";
  if (!["admin", "ganadero", "tecnico", "veterinario"].includes(at)) return res.status(400).json({ error: "account_type inválido" });
  const name = full_name && String(full_name).trim() ? String(full_name).trim() : "Usuario";
  const r = role && String(role).trim() ? String(role).trim() : "Ganadero";
  const loc = location != null && String(location).trim() ? String(location).trim() : null;
  try {
    const row = (
      await pool.query(
        `INSERT INTO users (full_name, role, account_type, account_status, location, email, password_hash)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)
         RETURNING id, full_name, role, account_type, account_status, location, email, created_at`,
        [name, r, at, loc, String(email).trim().toLowerCase(), hashPassword(password)]
      )
    ).rows[0];
    res.status(201).json({ user: row });
  } catch (e) {
    if (e && e.code === "23505") return res.status(409).json({ error: "El email ya está registrado" });
    res.status(500).json({ error: "No se pudo crear el usuario", detail: String(e.message || e) });
  }
});

app.patch("/api/admin/farms/:farmId/reassign", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const farmId = Number(req.params.farmId || 0);
  const newOwnerId = Number((req.body || {}).user_id || 0);
  if (!farmId || !newOwnerId) return res.status(400).json({ error: "farmId y user_id son obligatorios" });
  const u = (await pool.query(`SELECT id FROM users WHERE id = $1`, [newOwnerId])).rows[0];
  if (!u) return res.status(404).json({ error: "Usuario titular no encontrado" });
  const row = (await pool.query(`UPDATE farms SET user_id = $1 WHERE id = $2 RETURNING *`, [newOwnerId, farmId])).rows[0];
  if (!row) return res.status(404).json({ error: "Predio no encontrado" });
  await pool.query(`INSERT INTO audit_log (user_id, action, meta) VALUES ($1, $2, $3)`, [
    ctx.userId,
    "reassign_farm_owner",
    JSON.stringify({ farm_id: farmId, new_owner_id: newOwnerId }),
  ]);
  res.json(row);
});

app.get("/api/admin/farms/:farmId/access", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const farmId = Number(req.params.farmId || 0);
  if (!farmId) return res.status(400).json({ error: "farmId inválido" });
  const { rows } = await pool.query(
    `SELECT a.id, a.farm_id, a.user_id, a.permission_level, a.created_at, u.email, u.full_name
     FROM farm_user_access a
     JOIN users u ON u.id = a.user_id
     WHERE a.farm_id = $1
     ORDER BY a.id ASC`,
    [farmId]
  );
  res.json(rows);
});

app.post("/api/admin/farms/:farmId/access", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const farmId = Number(req.params.farmId || 0);
  const { user_id, permission_level } = req.body || {};
  const uid = Number(user_id || 0);
  const pl = permission_level != null ? String(permission_level).toLowerCase() : "";
  if (!farmId || !uid || !["lectura", "edicion"].includes(pl)) {
    return res.status(400).json({ error: "user_id y permission_level (lectura|edicion) son obligatorios" });
  }
  const farm = (await pool.query(`SELECT user_id FROM farms WHERE id = $1`, [farmId])).rows[0];
  if (!farm) return res.status(404).json({ error: "Predio no encontrado" });
  if (Number(farm.user_id) === uid) {
    return res.status(400).json({ error: "El titular ya tiene acceso completo; no hace falta delegación." });
  }
  try {
    const row = (
      await pool.query(
        `INSERT INTO farm_user_access (farm_id, user_id, permission_level, granted_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (farm_id, user_id) DO UPDATE SET permission_level = EXCLUDED.permission_level, granted_by_user_id = EXCLUDED.granted_by_user_id
         RETURNING *`,
        [farmId, uid, pl, ctx.userId]
      )
    ).rows[0];
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: "No se pudo asignar acceso", detail: String(e.message || e) });
  }
});

app.delete("/api/admin/farms/:farmId/access/:accessId", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });
  if (!ctx.isAdmin) return res.status(403).json({ error: "Solo administradores" });
  const farmId = Number(req.params.farmId || 0);
  const accessId = Number(req.params.accessId || 0);
  await pool.query(`DELETE FROM farm_user_access WHERE id = $1 AND farm_id = $2`, [accessId, farmId]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});
