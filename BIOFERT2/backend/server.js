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

/** @returns {Promise<{ userId: number, isAdmin: boolean } | null>} */
async function authContext(req) {
  const userId = getSessionUserId(req);
  if (!userId) return null;
  const row = (await pool.query(`SELECT id, account_type FROM users WHERE id = $1 LIMIT 1`, [userId])).rows[0];
  if (!row) return null;
  const isAdmin = String(row.account_type || "").toLowerCase() === "admin";
  return { userId: row.id, isAdmin };
}

async function assertFarmAccess(farmId, ctx) {
  if (!farmId || !ctx) return false;
  if (ctx.isAdmin) {
    const { rows } = await pool.query(`SELECT id FROM farms WHERE id = $1 LIMIT 1`, [farmId]);
    return rows.length > 0;
  }
  return assertFarmOwned(farmId, ctx.userId);
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
      INSERT INTO users (full_name, role, account_type, location, email, password_hash)
      VALUES ($1, 'Ganadero', 'ganadero', $2, $3, $4)
      RETURNING id, full_name, role, account_type, location, email;
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
  const sql = `SELECT id, full_name, role, account_type, location, email, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1;`;
  const row = (await pool.query(sql, [String(email).trim()])).rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "Credenciales incorrectas" });
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
  const userSql = `SELECT id, full_name, role, account_type, location, email, created_at FROM users WHERE id = $1 LIMIT 1;`;
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

// GET /api/farms
app.get("/api/farms", async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const sql = `
    SELECT id, user_id, name, location, area_ha, heads_active, breeds_text, thermal_floor, altitude_m, production_model, certification_step
    FROM farms
    WHERE user_id = $1
    ORDER BY id ASC;
  `;
  const { rows } = await pool.query(sql, [userId]);
  res.json(rows);
});

// PATCH /api/farms/:id — actualizar datos del predio
app.patch("/api/farms/:id", async (req, res) => {
  const ctx = await authContext(req);
  if (!ctx) return res.status(401).json({ error: "No autenticado" });

  const farmId = Number(req.params.id || 0);
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
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
      (CASE WHEN fr.status = 'pendiente' THEN 0 ELSE 1 END) ASC,
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
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
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
      r.id AS recommendation_id,
      r.title,
      r.expected_reduction_pct,
      r.difficulty,
      r.notes
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
  if (!farmId || !(await assertFarmAccess(farmId, ctx))) {
    return res.status(403).json({ error: "Finca no válida" });
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
    SELECT u.id, u.full_name, u.role, u.account_type, u.email, u.location, u.created_at,
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
  const { full_name, role, location, email, account_type, new_password } = req.body || {};
  const urow = (await pool.query(`SELECT id, account_type FROM users WHERE id = $1`, [targetId])).rows[0];
  if (!urow) return res.status(404).json({ error: "Usuario no encontrado" });

  const nextName = full_name != null ? String(full_name).trim() : null;
  const nextRole = role != null ? String(role).trim() : null;
  const nextLoc = location !== undefined ? (location != null && String(location).trim() ? String(location).trim() : null) : undefined;
  const nextEmail = email != null ? String(email).trim().toLowerCase() : null;
  const nextType = account_type != null ? String(account_type).toLowerCase() : null;
  const pwd = new_password != null ? String(new_password) : null;

  if (pwd && pwd.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  if (nextType && nextType !== "admin" && nextType !== "ganadero") {
    return res.status(400).json({ error: "account_type inválido" });
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
    if (sets.length === 0) return res.status(400).json({ error: "Sin cambios" });
    vals.push(targetId);
    await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    const user = (await pool.query(`SELECT id, full_name, role, account_type, location, email, created_at FROM users WHERE id = $1`, [targetId])).rows[0];
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

app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});
