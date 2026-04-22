const express = require("express");
const cors = require("cors");
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

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

// GET /api/profile
app.get("/api/profile", async (_req, res) => {
  const userSql = `SELECT id, full_name, role, location, email FROM users ORDER BY id ASC LIMIT 1;`;
  const user = (await pool.query(userSql)).rows[0] || null;
  res.json({ user });
});

// GET /api/farms?userId=1
app.get("/api/farms", async (req, res) => {
  const userId = Number(req.query.userId || 1);
  const sql = `
    SELECT id, user_id, name, location, area_ha, heads_active
    FROM farms
    WHERE user_id = $1
    ORDER BY id ASC;
  `;
  const { rows } = await pool.query(sql, [userId]);
  res.json(rows);
});

// GET /api/dashboard?farmId=1
app.get("/api/dashboard", async (req, res) => {
  const farmId = Number(req.query.farmId || 1);

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

  // Demo: % reducción mes = min( (tMonth / 10) * 100, 50 )
  const reductionMonthPct = Math.min((Number(tMonth) / 10) * 100, 50);

  // Bonos estimados (mes actual) = floor(tMonth)
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
  const farmId = Number(req.query.farmId || 1);

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

  // Para la demo usamos el total como "bonos verificados" e "ingresos acumulados"
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
  const farmId = Number(req.query.farmId || 1);

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
  const { farm_id = 1, code, zone, status = "activo", battery_pct = 100 } = req.body || {};

  if (!code || !zone) {
    return res.status(400).json({ error: "code y zone son obligatorios" });
  }

  const sql = `
    INSERT INTO sensors (farm_id, code, zone, status, battery_pct)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;

  const { rows } = await pool.query(sql, [farm_id, code, zone, status, battery_pct]);
  res.status(201).json(rows[0]);
});

// GET /api/recommendations?farmId=1
app.get("/api/recommendations", async (req, res) => {
  const farmId = Number(req.query.farmId || 1);

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
  const {
    farm_id = 1,
    title,
    expected_reduction_pct = null,
    difficulty = "media",
    notes = null,
  } = req.body || {};

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
    const farmRec = (await client.query(insFarmRec, [farm_id, rec.id])).rows[0];

    await client.query("COMMIT");
    res.status(201).json({ ...farmRec, recommendation: rec });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "No se pudo crear la recomendación", detail: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});

