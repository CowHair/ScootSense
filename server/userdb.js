// User data: accounts, home stash, saved projects, activity and the rider's own sensor
// readings. Stored in Tiger Data (PostgreSQL + TimescaleDB) when DATABASE_URL is set,
// otherwise in the local JSON store so development works with no setup.
import pg from 'pg';
import crypto from 'node:crypto';
import * as store from './store.js';

const url = process.env.DATABASE_URL?.trim();
let pool = url ? new pg.Pool({ ...connectionConfig(url), max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 }) : null;

/**
 * node-postgres treats sslmode=require as "verify the certificate", but Tiger Cloud (like
 * psql/libpq) means "always encrypt". Match libpq: encrypt, and verify only for verify-ca/verify-full.
 */
function connectionConfig(raw) {
  const mode = /[?&]sslmode=([^&]+)/.exec(raw)?.[1] || 'require';
  const connectionString = raw.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  if (mode === 'disable') return { connectionString, ssl: false };
  return { connectionString, ssl: mode.startsWith('verify') ? { rejectUnauthorized: true } : { rejectUnauthorized: false } };
}
let ready = null;

export const backend = () => (pool ? 'tiger' : 'local');
const newId = () => `u_${crypto.randomBytes(8).toString('hex')}`;

/** For tests: run the SQL backend against any client with a pg-compatible query(). */
export function useClient(client) { pool = client; ready = null; }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY,
     email text UNIQUE,
     name text NOT NULL,
     picture text,
     password_hash text,
     google_sub text UNIQUE,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_login timestamptz)`,
  `CREATE TABLE IF NOT EXISTS user_stash (
     user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name text NOT NULL,
     material text,
     qty integer NOT NULL DEFAULT 1,
     PRIMARY KEY (user_id, name))`,
  `CREATE TABLE IF NOT EXISTS user_projects (
     id text PRIMARY KEY,
     user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     data jsonb NOT NULL,
     origin text,
     saved_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS user_projects_user ON user_projects (user_id, saved_at DESC)`,
  // Time-series tables: TimescaleDB hypertables on Tiger, plain tables elsewhere.
  `CREATE TABLE IF NOT EXISTS user_activity (
     time timestamptz NOT NULL DEFAULT now(),
     user_id text NOT NULL,
     kind text NOT NULL,
     value double precision NOT NULL DEFAULT 1,
     meta jsonb)`,
  `CREATE INDEX IF NOT EXISTS user_activity_user ON user_activity (user_id, time DESC)`,
  `CREATE TABLE IF NOT EXISTS ride_observations (
     time timestamptz NOT NULL,
     user_id text,
     ride_id text NOT NULL,
     lat double precision,
     lng double precision,
     label text,
     score smallint,
     pm25 real,
     speed real)`,
  `CREATE INDEX IF NOT EXISTS ride_observations_ride ON ride_observations (ride_id, time)`,
  // Shared litter map: every rider sees it and can confirm whether it is still there.
  `CREATE TABLE IF NOT EXISTS litter (
     no serial PRIMARY KEY,
     id text UNIQUE NOT NULL,
     lat double precision NOT NULL,
     lng double precision NOT NULL,
     items jsonb NOT NULL DEFAULT '[]',
     summary text,
     photo text,
     status text NOT NULL DEFAULT 'reported',
     reporter_id text,
     at timestamptz NOT NULL DEFAULT now(),
     last_seen timestamptz NOT NULL DEFAULT now(),
     cleared_at timestamptz,
     checks jsonb NOT NULL DEFAULT '[]')`,
  // ESP32-CAM boards and the rider each one is linked to.
  `CREATE TABLE IF NOT EXISTS cam_devices (
     device_id text PRIMARY KEY,
     user_id text REFERENCES users(id) ON DELETE SET NULL,
     linked_at timestamptz,
     last_frame_at timestamptz,
     last_frame text,
     last_result text)`,
  `CREATE TABLE IF NOT EXISTS user_presence (
     user_id text PRIMARY KEY,
     lat double precision NOT NULL,
     lng double precision NOT NULL,
     at timestamptz NOT NULL)`,
  // Litter the camera found, waiting for the rider to choose pick up / map / dismiss.
  `CREATE TABLE IF NOT EXISTS trash_detections (
     id text PRIMARY KEY,
     user_id text NOT NULL,
     device_id text,
     time timestamptz NOT NULL DEFAULT now(),
     status text NOT NULL DEFAULT 'pending',
     items jsonb NOT NULL DEFAULT '[]',
     summary text,
     idea jsonb,
     photo text,
     lat double precision,
     lng double precision,
     litter_no integer,
     resolved_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS trash_detections_user ON trash_detections (user_id, status, time DESC)`,
  // The rider's trash list: everything they picked up.
  `CREATE TABLE IF NOT EXISTS user_trash (
     id text PRIMARY KEY,
     user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     time timestamptz NOT NULL DEFAULT now(),
     name text NOT NULL,
     material text,
     photo text,
     source text)`,
  `CREATE INDEX IF NOT EXISTS user_trash_user ON user_trash (user_id, time DESC)`,
];

const HYPERTABLES = ['user_activity', 'ride_observations'];

async function init() {
  if (!pool) return;
  for (const sql of SCHEMA) await pool.query(sql);
  for (const t of HYPERTABLES) {
    try {
      await pool.query(`SELECT create_hypertable('${t}', by_range('time'), if_not_exists => TRUE)`);
    } catch {
      // Older TimescaleDB, or plain Postgres without the extension: keep a normal table.
      try { await pool.query(`SELECT create_hypertable('${t}', 'time', if_not_exists => TRUE)`); } catch {}
    }
  }
}

export const sql = (text, params) => q(text, params);

async function q(text, params) {
  ready ??= init().catch((e) => { ready = null; throw e; });
  await ready;
  return pool.query(text, params);
}

// ---------------------------------------------------------------- local fallback

function local() {
  const db = store.getDb();
  db.users ??= [];
  db.userData ??= {};
  return db;
}
function localData(uid) {
  const db = local();
  return (db.userData[uid] ??= { stash: null, projects: [], activity: [] });
}

const pub = (u) => u && { id: u.id, email: u.email, name: u.name, picture: u.picture, hasPassword: !!(u.password_hash ?? u.passwordHash), google: !!(u.google_sub ?? u.googleSub) };

// ---------------------------------------------------------------- users

export async function findUser({ id, email, googleSub }) {
  if (pool) {
    const col = id ? 'id' : email ? 'email' : 'google_sub';
    const { rows } = await q(`SELECT * FROM users WHERE ${col} = $1`, [id || email?.toLowerCase() || googleSub]);
    return rows[0] || null;
  }
  return local().users.find((u) => (id && u.id === id) || (email && u.email === email.toLowerCase()) || (googleSub && u.google_sub === googleSub)) || null;
}

export async function createUser({ email, name, picture = null, passwordHash = null, googleSub = null }) {
  const u = { id: newId(), email: email?.toLowerCase() || null, name, picture, password_hash: passwordHash, google_sub: googleSub, created_at: new Date().toISOString() };
  if (pool) {
    await q('INSERT INTO users (id, email, name, picture, password_hash, google_sub) VALUES ($1,$2,$3,$4,$5,$6)',
      [u.id, u.email, u.name, u.picture, u.password_hash, u.google_sub]);
  } else {
    local().users.push(u);
    store.save();
  }
  return u;
}

export async function updateUser(id, fields) {
  const allowed = ['name', 'picture', 'google_sub', 'password_hash', 'last_login'];
  const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!entries.length) return;
  if (pool) {
    await q(`UPDATE users SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
  } else {
    const u = local().users.find((x) => x.id === id);
    if (u) Object.assign(u, Object.fromEntries(entries));
    store.save();
  }
}

export const publicUser = pub;

// ---------------------------------------------------------------- stash & projects

export async function getStash(uid) {
  if (pool) {
    const { rows } = await q('SELECT name, material, qty FROM user_stash WHERE user_id = $1 ORDER BY name', [uid]);
    return rows;
  }
  return localData(uid).stash || [];
}

export async function setStash(uid, items) {
  const clean = items.slice(0, 100).map((i) => ({ name: String(i.name).slice(0, 60), material: String(i.material || '').slice(0, 30), qty: Math.max(1, Math.min(999, Number(i.qty) || 1)) }))
    .filter((i, idx, arr) => i.name && arr.findIndex((x) => x.name.toLowerCase() === i.name.toLowerCase()) === idx);
  if (pool) {
    await q('DELETE FROM user_stash WHERE user_id = $1', [uid]);
    if (clean.length) {
      const vals = clean.map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(',');
      await q(`INSERT INTO user_stash (user_id, name, material, qty) VALUES ${vals}`, [uid, ...clean.flatMap((i) => [i.name, i.material, i.qty])]);
    }
  } else {
    localData(uid).stash = clean;
    store.save();
  }
  return clean;
}

export async function listProjects(uid) {
  if (pool) {
    const { rows } = await q('SELECT id, data, origin, saved_at FROM user_projects WHERE user_id = $1 ORDER BY saved_at DESC LIMIT 50', [uid]);
    return rows.map((r) => ({ ...r.data, id: r.id, origin: r.origin, savedAt: r.saved_at }));
  }
  return localData(uid).projects;
}

export async function addProject(uid, idea, origin) {
  const p = { id: `p_${crypto.randomBytes(6).toString('hex')}`, title: String(idea.title || 'Project').slice(0, 120), pitch: String(idea.pitch || '').slice(0, 400),
    steps: (idea.steps || []).slice(0, 10).map((s) => String(s).slice(0, 300)), minutes: Number(idea.minutes) || null,
    difficulty: String(idea.difficulty || '').slice(0, 20), usesFromHome: (idea.usesFromHome || []).slice(0, 10), extraNeeded: (idea.extraNeeded || []).slice(0, 10),
    safety: String(idea.safety || '').slice(0, 300) };
  const o = String(origin || '').slice(0, 200);
  if (pool) {
    const { id, ...data } = p;
    await q('INSERT INTO user_projects (id, user_id, data, origin) VALUES ($1,$2,$3,$4)', [id, uid, JSON.stringify(data), o]);
  } else {
    localData(uid).projects.unshift({ ...p, origin: o, savedAt: new Date().toISOString() });
    store.save();
  }
  await recordActivity(uid, 'project', 1, { title: p.title });
  return { ...p, origin: o };
}

export async function deleteProject(uid, pid) {
  if (pool) await q('DELETE FROM user_projects WHERE user_id = $1 AND id = $2', [uid, pid]);
  else {
    const d = localData(uid);
    d.projects = d.projects.filter((p) => p.id !== pid);
    store.save();
  }
}

// ---------------------------------------------------------------- activity (time series)

/** kind: ride_km | pickup | litter_report | hazard_hits | project | vote */
export async function recordActivity(uid, kind, value = 1, meta = null) {
  if (!uid) return;
  if (pool) await q('INSERT INTO user_activity (user_id, kind, value, meta) VALUES ($1,$2,$3,$4)', [uid, kind, value, meta ? JSON.stringify(meta) : null]);
  else {
    localData(uid).activity.push({ time: new Date().toISOString(), kind, value, meta });
    store.save();
  }
}

export async function insertObservations(uid, rideId, list) {
  if (!pool || !list.length) return; // the community store already keeps these locally
  const rows = list.filter((o) => Number.isFinite(o.lat));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals = chunk.map((_, j) => `(${Array.from({ length: 9 }, (_, k) => `$${j * 9 + k + 1}`).join(',')})`).join(',');
    await q(`INSERT INTO ride_observations (time, user_id, ride_id, lat, lng, label, score, pm25, speed) VALUES ${vals}`,
      chunk.flatMap((o) => [o.at || new Date().toISOString(), uid, rideId, o.lat, o.lng, o.label, Math.round(o.features?.score ?? o.score ?? 0), o.pm25 ?? null, o.speed ?? null]));
  }
}

/** Totals plus the last 8 weeks bucketed, for the profile screen. */
export async function activitySummary(uid) {
  const kinds = ['ride_km', 'pickup', 'litter_report', 'project', 'vote', 'hazard_hits'];
  const totals = Object.fromEntries(kinds.map((k) => [k, 0]));
  let weeks = [];
  if (pool) {
    const t = await q('SELECT kind, sum(value)::float AS v FROM user_activity WHERE user_id = $1 GROUP BY kind', [uid]);
    t.rows.forEach((r) => (totals[r.kind] = r.v));
    let w;
    try {
      // TimescaleDB time_bucket on Tiger; date_trunc keeps plain Postgres working too.
      w = await q(`SELECT time_bucket('7 days', time) AS week, sum(value) FILTER (WHERE kind = 'ride_km')::float AS km,
                     sum(value) FILTER (WHERE kind = 'pickup')::float AS pickups
                   FROM user_activity WHERE user_id = $1 AND time > now() - interval '8 weeks' GROUP BY week ORDER BY week`, [uid]);
    } catch {
      w = await q(`SELECT date_trunc('week', time) AS week, sum(value) FILTER (WHERE kind = 'ride_km')::float AS km,
                     sum(value) FILTER (WHERE kind = 'pickup')::float AS pickups
                   FROM user_activity WHERE user_id = $1 AND time > now() - interval '8 weeks' GROUP BY week ORDER BY week`, [uid]);
    }
    weeks = w.rows.map((r) => ({ week: r.week, km: r.km || 0, pickups: r.pickups || 0 }));
  } else {
    const a = localData(uid).activity;
    a.forEach((e) => (totals[e.kind] = (totals[e.kind] || 0) + e.value));
    const byWeek = new Map();
    for (const e of a) {
      const d = new Date(e.time);
      const wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay())).toISOString();
      const b = byWeek.get(wk) || { week: wk, km: 0, pickups: 0 };
      if (e.kind === 'ride_km') b.km += e.value;
      if (e.kind === 'pickup') b.pickups += e.value;
      byWeek.set(wk, b);
    }
    weeks = [...byWeek.values()].sort((x, y) => x.week.localeCompare(y.week)).slice(-8);
  }
  return { totals, weeks };
}

export async function health() {
  if (!pool) return { backend: 'local', ok: true };
  try {
    const { rows } = await q("SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'");
    let hypertables = [];
    if (rows[0]) hypertables = (await q('SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1')).rows.map((r) => r.hypertable_name);
    return { backend: 'tiger', ok: true, timescale: rows[0]?.extversion || null, hypertables };
  } catch (e) {
    return { backend: 'tiger', ok: false, error: e.message };
  }
}
