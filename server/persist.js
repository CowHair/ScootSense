import { usesSharedDatabase } from './database-config.js';
// Keeps the in-memory community store (store.js) in Tiger Data.
//
// The store does its maths in memory (hazard clustering, stats, grids). This module:
//  - hydrate():    loads rides, readings, hazards, training data, the model, settings and
//                  pickups from Tiger on a cold start, and catches up when another server
//                  instance has written (readings are loaded incrementally);
//  - persist():    saves only what changed since the last save, in one transaction, and
//                  bumps app.meta.version so other instances know to catch up.
// index.js calls ensureFresh() before every API request and persist() before replying to
// any write, so nothing is lost when Vercel freezes the function after the response.
import * as store from './store.js';
import * as users from './userdb.js';
import { seedDemo } from './seed.js';

const tiger = () => users.backend() === 'tiger';

let loaded = { version: -1, epoch: -1, maxTime: null };
let snap = emptySnap();
let hydrating = null;
let saving = Promise.resolve();
let lastCheck = 0;

function emptySnap() {
  return { rides: new Map(), hazards: new Map(), obs: new Set(), training: new Set(), model: 'null', settings: '', counters: '', pickups: 0 };
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const j = (v) => JSON.stringify(v ?? null);

// ---------------------------------------------------------------- row <-> memory

const rideRow = (r) => [r.id, r.name, r.source, r.device, r.userId ?? null, r.startedAt, r.endedAt, r.distanceM, r.observations, r.hazardHits, r.avgScore, r.summary];
const rideFrom = (r) => ({ id: r.id, name: r.name, source: r.source, device: r.device, userId: r.user_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
  distanceM: r.distance_m, observations: r.observations, hazardHits: r.hazard_hits, avgScore: r.avg_score, summary: r.summary });

const hazardRow = (h) => [h.id, h.no, h.lat, h.lng, h.type, h.severity, h.maxScore, h.hits, h.rideIds, h.firstSeen, h.lastSeen, h.status, j(h.votes), j(h.photos), j(h.notes), j(h.voters || [])];
const hazardFrom = (h) => ({ id: h.id, no: h.no, lat: h.lat, lng: h.lng, type: h.type, severity: h.severity, maxScore: h.max_score, hits: h.hits, rideIds: h.ride_ids || [],
  firstSeen: iso(h.first_seen), lastSeen: iso(h.last_seen), status: h.status, votes: h.votes, photos: h.photos || [], notes: h.notes || [], voters: h.voters || [] });

const obsRow = (o) => [o.at, o.id, o.rideId, o.t ?? null, o.lat, o.lng, o.speed, o.pm25 ?? null, o.label, o.confidence, o.model, o.score, j(o.f)];
const obsFrom = (o) => ({ id: o.id, rideId: o.ride_id, t: o.t_ms === null ? null : Number(o.t_ms), at: iso(o.time), lat: o.lat, lng: o.lng, speed: o.speed, pm25: o.pm25,
  label: o.label, confidence: o.confidence, model: o.model, score: o.score, f: o.features || {} });

async function insertMany(query, table, cols, rows, conflict = 'ON CONFLICT DO NOTHING') {
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const vals = chunk.map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(',')})`).join(',');
    await query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals} ${conflict}`, chunk.flat());
  }
}

// ---------------------------------------------------------------- load

async function hydrate(full) {
  const db = store.getDb();
  const [{ rows: [meta] }, rides, hazards, training, model, settings, pickups] = await Promise.all([
    users.sql('SELECT version, obs_epoch FROM app.meta'),
    users.sql('SELECT * FROM sensing.rides ORDER BY started_at'),
    users.sql('SELECT * FROM city.hazards ORDER BY no'),
    users.sql('SELECT * FROM ml.training_samples ORDER BY at'),
    users.sql('SELECT model FROM ml.models WHERE active ORDER BY id DESC LIMIT 1'),
    users.sql('SELECT key, value FROM app.settings'),
    users.sql('SELECT time, count, materials FROM city.pickups ORDER BY seq'),
  ]);
  const epoch = Number(meta.obs_epoch);
  const reloadAll = full || epoch !== loaded.epoch || !loaded.maxTime;

  // Readings: everything on a cold start (or after deletions), otherwise only what's new.
  const { rows: obsRows } = reloadAll
    ? await users.sql('SELECT * FROM sensing.observations ORDER BY time')
    : await users.sql('SELECT * FROM sensing.observations WHERE time >= $1 ORDER BY time', [loaded.maxTime]);
  if (reloadAll) { db.observations = []; snap.obs = new Set(); }
  for (const r of obsRows) {
    if (snap.obs.has(r.id)) continue;
    db.observations.push(obsFrom(r));
    snap.obs.add(r.id);
  }
  const last = db.observations.at(-1);
  loaded.maxTime = last?.at || loaded.maxTime;

  db.rides = rides.rows.map(rideFrom);
  db.hazards = hazards.rows.map(hazardFrom);
  db.trainingSamples = training.rows.map((t) => ({ id: t.id, label: t.label, recordingId: t.recording_id, features: t.features, source: t.source, at: iso(t.at) }));
  db.model = model.rows[0]?.model ?? null;
  const kv = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
  if (kv.settings) db.settings = kv.settings;
  if (kv.counters) Object.assign(db, kv.counters);
  db.pickups = pickups.rows.map((p) => ({ at: iso(p.time), count: p.count, materials: p.materials }));

  snap.rides = new Map(db.rides.map((r) => [r.id, j(r)]));
  snap.hazards = new Map(db.hazards.map((h) => [h.id, j(h)]));
  snap.training = new Set(db.trainingSamples.map((t) => t.id));
  snap.model = j(db.model);
  snap.settings = j(db.settings);
  snap.counters = j(counters(db));
  snap.pickups = db.pickups.length;
  loaded.version = Number(meta.version);
  loaded.epoch = epoch;
}

const counters = (db) => ({ nextHazardNo: db.nextHazardNo, upcycleIdeas: db.upcycleIdeas });

// ---------------------------------------------------------------- save

/** Saves everything that changed in memory since the last save. Serialised; safe to call often. */
export function persist() {
  if (!tiger()) return Promise.resolve();
  saving = saving.then(saveChanges, saveChanges);
  return saving;
}

async function saveChanges() {
  const db = store.getDb();
  const rideIds = new Set(db.rides.map((r) => r.id));
  const goneRides = [...snap.rides.keys()].filter((id) => !rideIds.has(id));
  const changedRides = db.rides.filter((r) => snap.rides.get(r.id) !== j(r));
  const newObs = db.observations.filter((o) => !snap.obs.has(o.id));
  const hazardIds = new Set(db.hazards.map((h) => h.id));
  const goneHazards = [...snap.hazards.keys()].filter((id) => !hazardIds.has(id));
  const changedHazards = db.hazards.filter((h) => snap.hazards.get(h.id) !== j(h));
  const trainIds = new Set(db.trainingSamples.map((t) => t.id));
  const goneTraining = [...snap.training].filter((id) => !trainIds.has(id));
  const newTraining = db.trainingSamples.filter((t) => !snap.training.has(t.id));
  const modelChanged = j(db.model) !== snap.model;
  const settingsChanged = j(db.settings) !== snap.settings;
  const countersChanged = j(counters(db)) !== snap.counters;
  const pickupsReset = db.pickups.length < snap.pickups;
  const newPickups = pickupsReset ? db.pickups : db.pickups.slice(snap.pickups);

  const nothing = !goneRides.length && !changedRides.length && !newObs.length && !goneHazards.length && !changedHazards.length
    && !goneTraining.length && !newTraining.length && !modelChanged && !settingsChanged && !countersChanged && !pickupsReset && !newPickups.length;
  if (nothing) return;

  const meta = await users.transaction(async (query) => {
    if (goneRides.length) {
      await query('DELETE FROM sensing.observations WHERE ride_id = ANY($1)', [goneRides]);
      await query('DELETE FROM sensing.rides WHERE id = ANY($1)', [goneRides]);
    }
    if (changedRides.length) {
      await insertMany(query, 'sensing.rides',
        ['id', 'name', 'source', 'device', 'user_id', 'started_at', 'ended_at', 'distance_m', 'observations', 'hazard_hits', 'avg_score', 'summary'],
        changedRides.map(rideRow),
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, ended_at = EXCLUDED.ended_at, distance_m = EXCLUDED.distance_m,
           observations = EXCLUDED.observations, hazard_hits = EXCLUDED.hazard_hits, avg_score = EXCLUDED.avg_score, summary = EXCLUDED.summary`);
    }
    if (newObs.length) {
      await insertMany(query, 'sensing.observations',
        ['time', 'id', 'ride_id', 't_ms', 'lat', 'lng', 'speed', 'pm25', 'label', 'confidence', 'model', 'score', 'features'], newObs.map(obsRow));
    }
    if (goneHazards.length) await query('DELETE FROM city.hazards WHERE id = ANY($1)', [goneHazards]);
    if (changedHazards.length) {
      // Clear any number a rebuilt hazard is about to take, then upsert.
      await query('DELETE FROM city.hazards WHERE no = ANY($1) AND NOT (id = ANY($2))', [changedHazards.map((h) => h.no), changedHazards.map((h) => h.id)]);
      await insertMany(query, 'city.hazards',
        ['id', 'no', 'lat', 'lng', 'type', 'severity', 'max_score', 'hits', 'ride_ids', 'first_seen', 'last_seen', 'status', 'votes', 'photos', 'notes', 'voters'],
        changedHazards.map(hazardRow),
        `ON CONFLICT (id) DO UPDATE SET no = EXCLUDED.no, lat = EXCLUDED.lat, lng = EXCLUDED.lng, type = EXCLUDED.type, severity = EXCLUDED.severity,
           max_score = EXCLUDED.max_score, hits = EXCLUDED.hits, ride_ids = EXCLUDED.ride_ids, first_seen = EXCLUDED.first_seen,
           last_seen = EXCLUDED.last_seen, status = EXCLUDED.status, votes = EXCLUDED.votes, photos = EXCLUDED.photos, notes = EXCLUDED.notes, voters = EXCLUDED.voters`);
    }
    if (goneTraining.length) await query('DELETE FROM ml.training_samples WHERE id = ANY($1)', [goneTraining]);
    if (newTraining.length) {
      await insertMany(query, 'ml.training_samples', ['id', 'label', 'recording_id', 'features', 'source', 'at'],
        newTraining.map((t) => [t.id, t.label, t.recordingId, j(t.features), t.source, t.at]));
    }
    if (modelChanged) {
      await query('UPDATE ml.models SET active = false WHERE active');
      if (db.model) await query('INSERT INTO ml.models (model) VALUES ($1)', [j(db.model)]);
    }
    const setting = (key, value) => query(`INSERT INTO app.settings (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, j(value)]);
    if (settingsChanged) await setting('settings', db.settings);
    if (countersChanged) await setting('counters', counters(db));
    if (pickupsReset) await query('DELETE FROM city.pickups');
    if (newPickups.length) {
      await insertMany(query, 'city.pickups', ['time', 'count', 'materials'], newPickups.map((p) => [p.at, p.count, p.materials || []]));
    }
    const { rows } = await query(`UPDATE app.meta SET version = version + 1${goneRides.length ? ', obs_epoch = obs_epoch + 1' : ''} RETURNING version, obs_epoch`);
    return rows[0];
  });

  // Everything above is now in Tiger: remember it as saved.
  changedRides.forEach((r) => snap.rides.set(r.id, j(r)));
  goneRides.forEach((id) => snap.rides.delete(id));
  newObs.forEach((o) => snap.obs.add(o.id));
  if (goneRides.length) snap.obs = new Set(db.observations.map((o) => o.id));
  changedHazards.forEach((h) => snap.hazards.set(h.id, j(h)));
  goneHazards.forEach((id) => snap.hazards.delete(id));
  newTraining.forEach((t) => snap.training.add(t.id));
  goneTraining.forEach((id) => snap.training.delete(id));
  snap.model = j(db.model);
  snap.settings = j(db.settings);
  snap.counters = j(counters(db));
  snap.pickups = db.pickups.length;
  const last = db.observations.at(-1);
  if (last?.at && (!loaded.maxTime || last.at > loaded.maxTime)) loaded.maxTime = last.at;
  loaded.version = Number(meta.version);
  loaded.epoch = Number(meta.obs_epoch);
}

// ---------------------------------------------------------------- freshness

/**
 * Before each API request: on a cold start load everything from Tiger (seeding the demo if
 * the database is empty); afterwards catch up only when another instance has written.
 */
export function ensureFresh() {
  if (!tiger()) return Promise.resolve();
  hydrating ??= (async () => {
    try {
      await saving; // never overwrite our own unsaved writes
      if (loaded.version < 0) {
        await hydrate(true);
        if (!usesSharedDatabase && !store.getDb().rides.length) await seedOnce();
        return;
      }
      if (Date.now() - lastCheck < 1000) return; // a burst of requests shares one check
      lastCheck = Date.now();
      const { rows: [meta] } = await users.sql('SELECT version, obs_epoch FROM app.meta');
      if (Number(meta.version) !== loaded.version) await hydrate(Number(meta.obs_epoch) !== loaded.epoch);
    } finally {
      hydrating = null;
    }
  })();
  return hydrating;
}

/**
 * Several cold instances can start against an empty database at once: only the one holding
 * the advisory lock seeds; the others wait, then load what it saved.
 */
async function seedOnce() {
  await users.transaction(async (query) => {
    await query('SELECT pg_advisory_xact_lock(7224001)');
    const { rows: [r] } = await query('SELECT count(*)::int AS n FROM sensing.rides');
    if (r.n) return;
    console.log('Tiger has no rides yet: seeding the demo data…');
    seedDemo();
    await saveChanges();
  });
  if (!snap.rides.size) await hydrate(true); // another instance seeded while we waited
}

/** For tests. */
export function _resetForTests() { loaded = { version: -1, epoch: -1, maxTime: null }; snap = emptySnap(); }

export async function refreshFromDatabase() { await saving; await hydrate(true); lastCheck=Date.now(); }
