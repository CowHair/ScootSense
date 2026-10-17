// User data: accounts, home stash, saved projects, activity and the rider's own sensor
// readings. Stored in Tiger Data (PostgreSQL + TimescaleDB) when DATABASE_URL is set,
// otherwise in the local JSON store so development works with no setup.
import pg from 'pg';
import crypto from 'node:crypto';
import * as store from './store.js';
import { migrate, SEARCH_PATH, SCHEMAS } from './schema.js';

const url = process.env.DATABASE_URL?.trim();
let pool = url ? new pg.Pool({ ...connectionConfig(url), max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 }) : null;
// Each pooled connection resolves table names through the ScootSense schemas (see schema.js).
pool?.on('connect', (client) => client.query(`SET search_path TO ${SEARCH_PATH}`).catch(() => {}));

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

async function init() {
  if (!pool) return;
  // Every query below uses unqualified names; the search path maps them to their schema.
  await pool.query(`SET search_path TO ${SEARCH_PATH}`);
  await migrate((text, params) => pool.query(text, params));
}

export const sql = (text, params) => q(text, params);

/** Run fn(query) inside one transaction on a single connection (falls back to plain queries in tests). */
export async function transaction(fn) {
  ready ??= init().catch((e) => { ready = null; throw e; });
  await ready;
  if (typeof pool.connect !== 'function') return fn((t, p) => pool.query(t, p));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((t, p) => client.query(t, p));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

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

const pub = (u) => u && { id: u.id, email: u.email, name: u.name, picture: u.picture, hasPassword: !!(u.password_hash ?? u.passwordHash), google: !!(u.google_sub ?? u.googleSub), prefs: u.prefs || {} };

/** Look-and-feel choices (chosen chibi and its animation). Merged into what is already saved. */
export async function setPrefs(uid, prefs) {
  if (pool) {
    const { rows } = await q('UPDATE users SET prefs = prefs || $2::jsonb WHERE id = $1 RETURNING *', [uid, JSON.stringify(prefs)]);
    return pub(rows[0]);
  }
  const u = local().users.find((x) => x.id === uid);
  if (!u) return null;
  u.prefs = { ...(u.prefs || {}), ...prefs };
  store.save();
  return pub(u);
}

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

/** Attach a (client-compressed) picture of the finished project. */
export async function setProjectImage(uid, pid, image) {
  if (pool) {
    await q(`UPDATE user_projects SET data = data || jsonb_build_object('image', $3::text) WHERE user_id = $1 AND id = $2`, [uid, pid, image]);
  } else {
    const p = localData(uid).projects.find((x) => x.id === pid);
    if (p) p.image = image;
    store.save();
  }
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
    if (rows[0]) hypertables = (await q(`SELECT hypertable_schema || '.' || hypertable_name AS h, compression_enabled AS c
      FROM timescaledb_information.hypertables ORDER BY 1`)).rows.map((r) => (r.c ? `${r.h} (compressed after 7 days)` : r.h));
    return { backend: 'tiger', ok: true, timescale: rows[0]?.extversion || null, hypertables };
  } catch (e) {
    return { backend: 'tiger', ok: false, error: e.message };
  }
}

/** Row counts for every table, grouped by schema (shown on the About screen and /api/db). */
export async function layout() {
  if (!pool) return null;
  const { rows } = await q(`SELECT table_schema AS s, table_name AS t FROM information_schema.tables
    WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE' ORDER BY 1, 2`, [SCHEMAS]);
  const out = {};
  for (const { s, t } of rows) {
    const { rows: [c] } = await q(`SELECT count(*)::int AS n FROM ${s}.${t}`);
    (out[s] ??= {})[t] = c.n;
  }
  return out;
}
