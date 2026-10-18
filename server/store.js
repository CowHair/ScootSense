// Tiny JSON-file database. Good enough for a hackathon, zero native dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CLASS_INFO, haversine, round, POLLUTION_THRESHOLD, AIR_LEVEL_INFO } from '../shared/signal.js';

// Vercel's filesystem is read-only except /tmp, which lasts only as long as the instance.
export const DATA_DIR = process.env.VERCEL ? '/tmp/scootsense' : path.resolve(import.meta.dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const HAZARD_RADIUS_M = 14;

const empty = () => ({
  rides: [],
  observations: [],
  hazards: [],
  trainingSamples: [],
  model: null,
  settings: { locationDecimals: 5, privacyZones: [] },
  nextHazardNo: 1,
  litter: [],
  pickups: [],      // anonymous: no location is stored when a rider picks trash up
  upcycleIdeas: 0,
});

let db = load();
let saveTimer = null;

function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    return empty();
  }
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

export function flush() {
  clearTimeout(saveTimer);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_PATH);
}

/** Resets community data. Accounts and personal data (local mode) are kept. */
export function reset() {
  const { users = [], userData = {} } = db;
  db = { ...empty(), users, userData };
  flush();
}

export const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
export const getDb = () => db;

// ---------- rides ----------

export function createRide({ name, source = 'serial', device = null, userId = null }) {
  const ride = {
    id: id('ride'), name: name || `Ride ${db.rides.length + 1}`, source, device, userId,
    startedAt: new Date().toISOString(), endedAt: null,
    distanceM: 0, observations: 0, hazardHits: 0, avgScore: 0, summary: null,
  };
  db.rides.push(ride);
  save();
  return ride;
}

export function getRide(rideId) {
  return db.rides.find((r) => r.id === rideId);
}

export function deleteRide(rideId) {
  db.rides = db.rides.filter((r) => r.id !== rideId);
  db.observations = db.observations.filter((o) => o.rideId !== rideId);
  // Rebuild hazards from what remains so a deleted ride leaves no trace.
  const keep = db.hazards.map((h) => ({ id: h.id, no: h.no, status: h.status, votes: h.votes, photos: h.photos, notes: h.notes }));
  db.hazards = [];
  for (const o of db.observations) if (CLASS_INFO[o.label]?.hazard) attachToHazard(o);
  for (const h of db.hazards) {
    const prev = keep.find((k) => haversine(k, h) < HAZARD_RADIUS_M) || null;
    if (prev) Object.assign(h, { id: prev.id, no: prev.no, status: prev.status, votes: prev.votes, photos: prev.photos, notes: prev.notes });
  }
  save();
}

// ---------- observations & hazard clustering ----------

export function inPrivacyZone(lat, lng) {
  return db.settings.privacyZones.some((z) => haversine(z, { lat, lng }) <= z.radius);
}

/**
 * obs: { t, lat, lng, speed, features, label, confidence, probs, model }
 * Returns { stored, hazards } where hazards are the ones touched.
 */
export function addObservations(rideId, list) {
  const ride = getRide(rideId);
  if (!ride) throw Object.assign(new Error('Unknown ride'), { status: 404 });
  const d = db.settings.locationDecimals;
  const touched = new Map();
  let stored = 0;
  let last = db.observations.findLast((o) => o.rideId === rideId && o.lat !== null);

  for (const raw of list) {
    let lat = Number.isFinite(raw.lat) ? round(raw.lat, d) : null;
    let lng = Number.isFinite(raw.lng) ? round(raw.lng, d) : null;
    if (lat !== null && inPrivacyZone(lat, lng)) continue; // never stored
    const f = raw.features || {};
    const o = {
      id: id('obs'), rideId, t: raw.t ?? Date.now(), at: raw.at || new Date().toISOString(),
      lat, lng, speed: raw.speed ?? null, pm25: Number.isFinite(raw.pm25) ? raw.pm25 : null,
      label: raw.label, confidence: round(raw.confidence ?? 0, 3), model: raw.model || 'rules',
      score: f.score ?? 0,
      f: { std: f.std, maxDev: f.maxDev, p2p: f.p2p, jerk: f.jerk, kurtosis: f.kurtosis, domFreq: f.domFreq, hfRatio: f.hfRatio,
        ...(f.airLevel ? { gas: f.gas, airLevel: f.airLevel } : {}) },
    };
    db.observations.push(o);
    stored++;
    if (lat !== null && last && last.lat !== null) {
      // GPS speed integrates far better than summing jittery 1 Hz fixes.
      const dtS = (o.t - last.t) / 1000;
      const step = Number.isFinite(o.speed) && dtS > 0 && dtS < 5 ? (o.speed / 3.6) * dtS : haversine(last, o);
      if (step < 60) ride.distanceM += step; // ignore GPS jumps
    }
    if (lat !== null) last = o;
    ride.avgScore = round((ride.avgScore * ride.observations + o.score) / (ride.observations + 1), 1);
    ride.observations++;
    if (CLASS_INFO[o.label]?.hazard && lat !== null && o.confidence >= 0.55) {
      ride.hazardHits++;
      const h = attachToHazard(o);
      touched.set(h.id, h);
    }
  }
  ride.distanceM = round(ride.distanceM, 1);
  save();
  return { stored, hazards: [...touched.values()] };
}

function attachToHazard(o) {
  let best = null, bestD = Infinity;
  for (const h of db.hazards) {
    const dist = haversine(h, o);
    if (dist < HAZARD_RADIUS_M && dist < bestD) { best = h; bestD = dist; }
  }
  if (!best) {
    best = {
      id: id('hz'), no: db.nextHazardNo++, lat: o.lat, lng: o.lng, type: o.label,
      severity: o.score, maxScore: o.score, hits: 0, rideIds: [], firstSeen: o.at, lastSeen: o.at,
      status: 'unverified', votes: { confirm: 0, dismiss: 0 }, photos: [], notes: [],
    };
    db.hazards.push(best);
  }
  const n = best.hits;
  best.lat = round((best.lat * n + o.lat) / (n + 1), 6);
  best.lng = round((best.lng * n + o.lng) / (n + 1), 6);
  best.hits++;
  best.severity = Math.round((best.severity * n + o.score) / (n + 1));
  best.maxScore = Math.max(best.maxScore, o.score);
  if (o.label === 'bump') best.type = 'bump'; // worst defect seen wins
  if (!best.rideIds.includes(o.rideId)) best.rideIds.push(o.rideId);
  best.lastSeen = o.at;
  return best;
}

// ---------- hazard views ----------

export function hazardView(h) {
  const reports = h.rideIds.length;
  const totalRides = Math.max(1, db.rides.length);
  // Repeated, independent detections raise confidence; community votes override.
  let confidence = 1 - Math.exp(-reports / 1.6);
  if (h.status === 'confirmed') confidence = Math.max(confidence, 0.95);
  if (h.status === 'dismissed') confidence = Math.min(confidence, 0.1);
  const priority = h.status === 'dismissed' ? 0
    : Math.round(h.severity * (0.4 + 0.6 * confidence) * (1 + Math.log2(1 + reports) / 3) * (h.status === 'confirmed' ? 1.2 : 1));
  const { voters, ...pub } = h; // who voted stays on the server
  return {
    ...pub, photos: (h.photos || []).map(({ by, ...ph }) => ph), reports, confidence: round(confidence, 2), detectionRate: round(reports / totalRides, 2),
    priority, typeLabel: CLASS_INFO[h.type]?.label || h.type,
  };
}

export function listHazards({ status, minReports = 1 } = {}) {
  return db.hazards
    .map(hazardView)
    .filter((h) => (!status || h.status === status) && h.reports >= minReports)
    .sort((a, b) => b.priority - a.priority);
}

export function getHazard(hid) {
  const h = db.hazards.find((x) => x.id === hid || String(x.no) === String(hid));
  return h ? hazardView(h) : null;
}

export function rawHazard(hid) {
  return db.hazards.find((x) => x.id === hid || String(x.no) === String(hid));
}

export function voteHazard(hid, vote, by = null) {
  const h = rawHazard(hid);
  if (!h) return null;
  // Who voted, so the riders who confirmed a hazard can be rewarded (kept server-side only).
  if (by) h.voters = [...(h.voters || []), { by, vote, at: new Date().toISOString() }].slice(-50);
  if (vote === 'confirm') h.votes.confirm++;
  else if (vote === 'dismiss') h.votes.dismiss++;
  else if (vote === 'fixed') h.status = 'fixed';
  if (vote !== 'fixed') {
    const { confirm, dismiss } = h.votes;
    h.status = confirm > dismiss ? 'confirmed' : dismiss > confirm ? 'dismissed' : 'unverified';
  }
  save();
  return hazardView(h);
}

// ---------- stats ----------

export function stats() {
  const hz = db.hazards.map(hazardView);
  const decided = hz.filter((h) => h.status === 'confirmed' || h.status === 'dismissed' || h.status === 'fixed');
  const confirmed = hz.filter((h) => h.status === 'confirmed' || h.status === 'fixed');
  const byType = {};
  for (const h of hz) if (h.status !== 'dismissed') byType[h.type] = (byType[h.type] || 0) + 1;
  const labelCounts = {};
  for (const o of db.observations) labelCounts[o.label] = (labelCounts[o.label] || 0) + 1;
  const distanceM = db.rides.reduce((s, r) => s + r.distanceM, 0);
  const geo = db.observations.filter((o) => o.lat !== null);
  const avgScore = geo.length ? geo.reduce((s, o) => s + o.score, 0) / geo.length : 0;
  return {
    rides: db.rides.length,
    distanceKm: round(distanceM / 1000, 2),
    observations: db.observations.length,
    geotagged: geo.length,
    hazards: hz.filter((h) => h.status !== 'dismissed').length,
    repeatedHazards: hz.filter((h) => h.reports >= 2 && h.status !== 'dismissed').length,
    confirmed: confirmed.length,
    dismissed: hz.filter((h) => h.status === 'dismissed').length,
    fixed: hz.filter((h) => h.status === 'fixed').length,
    verificationPrecision: decided.length ? round(confirmed.length / decided.length, 2) : null,
    photosAnalyzed: hz.reduce((s, h) => s + h.photos.length, 0),
    byType, labelCounts,
    avgRoughness: round(avgScore, 1),
    hazardsPerKm: distanceM ? round(hz.filter((h) => h.status !== 'dismissed').length / (distanceM / 1000), 2) : 0,
    model: db.model ? { type: db.model.type, trainedAt: db.model.trainedAt, n: db.model.n, metrics: db.model.metrics } : null,
    trainingSamples: db.trainingSamples.length,
    litterOnMap: db.litter.filter((l) => l.status === 'reported').length,
    litterCleared: db.litter.filter((l) => l.status === 'cleared').length,
    itemsPickedUp: db.pickups.reduce((s, p) => s + p.count, 0),
    upcycleIdeas: db.upcycleIdeas,
    pollutionHotspots: pollutionHotspots().length,
    avgPm25: avgPm(),
  };
}

/** Road segments: grid cells (~25 m) with their average roughness, for the heatmap and the AI. */
export function roughnessGrid(cell = 0.00025) {
  const cells = new Map();
  for (const o of db.observations) {
    if (o.lat === null) continue;
    const key = `${Math.round(o.lat / cell)}:${Math.round(o.lng / cell)}`;
    const c = cells.get(key) || { lat: 0, lng: 0, n: 0, score: 0, hazards: 0, pmSum: 0, pmN: 0 };
    c.lat += o.lat; c.lng += o.lng; c.n++; c.score += o.score;
    if (Number.isFinite(o.pm25)) { c.pmSum += o.pm25; c.pmN++; }
    if (CLASS_INFO[o.label]?.hazard) c.hazards++;
    cells.set(key, c);
  }
  return [...cells.values()].map((c) => ({
    lat: round(c.lat / c.n, 6), lng: round(c.lng / c.n, 6), n: c.n,
    score: Math.round(c.score / c.n), hazardShare: round(c.hazards / c.n, 2),
    pm25: c.pmN ? round(c.pmSum / c.pmN, 1) : null,
  }));
}

// ---------- air quality ----------

function avgPm() {
  const v = db.observations.filter((o) => Number.isFinite(o.pm25));
  return v.length ? round(v.reduce((s, o) => s + o.pm25, 0) / v.length, 1) : null;
}

/** Grid cells whose average PM2.5 exceeds the "unhealthy for sensitive groups" line. */
export function pollutionHotspots() {
  const cells = roughnessGrid()
    .filter((c) => c.pm25 !== null && c.pm25 >= POLLUTION_THRESHOLD && c.n >= 3)
    .sort((a, b) => b.pm25 - a.pm25);
  // Merge neighbouring cells into one hotspot, located at its worst cell.
  const spots = [];
  for (const c of cells) {
    const near = spots.find((s) => haversine(s, c) < 120);
    if (near) { near.n += c.n; near.cells++; }
    else spots.push({ lat: c.lat, lng: c.lng, pm25: c.pm25, n: c.n, cells: 1 });
  }
  return spots.concat(badAirSpots(spots));
}

/**
 * Places where the ESP32's gas sensor read "high" or "severe" in at least half of 2+ readings.
 * Kept apart from PM2.5 hotspots: it measures gases, not particles, so it has no µg/m³.
 */
function badAirSpots(pmSpots, cell = 0.00025) {
  const ORDER = Object.keys(AIR_LEVEL_INFO);
  const cells = new Map();
  for (const o of db.observations) {
    const level = o.f?.airLevel;
    if (o.lat === null || !AIR_LEVEL_INFO[level]) continue;
    const key = `${Math.round(o.lat / cell)}:${Math.round(o.lng / cell)}`;
    const c = cells.get(key) || { lat: 0, lng: 0, n: 0, bad: 0, gasSum: 0, gasN: 0, worst: 'fresh' };
    c.lat += o.lat; c.lng += o.lng; c.n++;
    if (AIR_LEVEL_INFO[level].bad) c.bad++;
    if (ORDER.indexOf(level) > ORDER.indexOf(c.worst)) c.worst = level;
    if (Number.isFinite(o.f.gas)) { c.gasSum += o.f.gas; c.gasN++; }
    cells.set(key, c);
  }
  const spots = [];
  for (const c of [...cells.values()].filter((x) => x.n >= 2 && x.bad / x.n >= 0.5).sort((a, b) => b.bad - a.bad)) {
    const s = { lat: round(c.lat / c.n, 6), lng: round(c.lng / c.n, 6), pm25: null, airLevel: c.worst,
      gas: c.gasN ? Math.round(c.gasSum / c.gasN) : null, n: c.n, cells: 1, source: 'gas' };
    const near = spots.find((x) => haversine(x, s) < 120);
    if (near) { near.n += s.n; near.cells++; }
    else if (!pmSpots.some((x) => haversine(x, s) < 40)) spots.push(s);
  }
  return spots;
}

// ---------- litter ----------

export function addLitter({ lat, lng, items = [], summary = '', photo = null, status, reporterId = null }) {
  const d = db.settings.locationDecimals;
  if (status === 'picked') {
    db.pickups.push({ at: new Date().toISOString(), count: Math.max(1, items.length), materials: items.map((i) => i.material).filter(Boolean) });
    save();
    return { picked: true };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw Object.assign(new Error('Location needed to map litter'), { status: 400 });
  if (inPrivacyZone(lat, lng)) throw Object.assign(new Error('That spot is inside a privacy zone'), { status: 400 });
  const l = {
    id: id('lt'), no: (db.litter.at(-1)?.no || 0) + 1, lat: round(lat, d), lng: round(lng, d),
    items: items.slice(0, 8).map((i) => ({ name: String(i.name || 'item').slice(0, 60), material: String(i.material || '').slice(0, 30) })),
    summary: String(summary).slice(0, 200), photo, status: 'reported', at: new Date().toISOString(),
    reporterId, lastSeen: new Date().toISOString(), checks: [],
  };
  db.litter.push(l);
  save();
  return l;
}

export function clearLitter(lid) {
  const l = db.litter.find((x) => x.id === lid || String(x.no) === String(lid));
  if (!l) return null;
  l.status = 'cleared';
  l.clearedAt = new Date().toISOString();
  db.pickups.push({ at: l.clearedAt, count: Math.max(1, l.items.length), materials: l.items.map((i) => i.material) });
  save();
  return l;
}
