// Litter that needs to be shared between riders and server instances: the litter map
// (with "still there?" checks), ESP32-CAM devices, rider presence, pending camera
// detections and each rider's trash list. Tiger Data when DATABASE_URL is set,
// otherwise the local JSON store.
import * as chain from './chain.js';
import crypto from 'node:crypto';
import * as store from './store.js';
import { sql, backend } from './userdb.js';
import { haversine, round } from '../shared/signal.js';

const tiger = () => backend() === 'tiger';
const rid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const iso = (v) => (v ? new Date(v).toISOString() : null);
const now = () => new Date().toISOString();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_PHOTO = 160_000; // data URL characters

function mem() {
  const db = store.getDb();
  db.devices ??= [];
  db.detections ??= [];
  db.userTrash ??= [];
  db.presence ??= {};
  return db;
}

export const cleanPhoto = (p) => (typeof p === 'string' && p.startsWith('data:image/') && p.length <= MAX_PHOTO ? p : null);
const cleanItems = (items) => (Array.isArray(items) ? items : []).slice(0, 8)
  .map((i) => ({
    name: String(i.name || 'item').slice(0, 60), material: String(i.material || '').slice(0, 30),
    ...(i.pickupSafe === false ? { pickupSafe: false } : {}),
    // What a smart camera saw: its own words and how sure it was.
    ...(i.description ? { description: String(i.description).slice(0, 160) } : {}),
    ...(Number.isFinite(i.confidence) ? { confidence: Math.round(Math.max(0, Math.min(1, i.confidence)) * 100) / 100 } : {}),
  }));

// ---------------------------------------------------------------- litter map

const litterFromRow = (r) => ({
  id: r.id, no: r.no, lat: r.lat, lng: r.lng, items: r.items || [], summary: r.summary || '', photo: r.photo,
  status: r.status, reporterId: r.reporter_id, at: iso(r.at), lastSeen: iso(r.last_seen), clearedAt: iso(r.cleared_at), checks: r.checks || [],
});

let seededTiger = false;

/** All litter (reported and cleared). Also refreshes the in-memory copy used by stats and Gemini. */
export async function listLitter() {
  if (!tiger()) return store.getDb().litter;
  let { rows } = await sql('SELECT * FROM litter ORDER BY no');
  if (!rows.length && !seededTiger) {
    seededTiger = true; // first run against an empty database: carry over the demo litter
    for (const l of store.getDb().litter.filter((x) => x.status === 'reported')) await insertLitter(l);
    ({ rows } = await sql('SELECT * FROM litter ORDER BY no'));
  }
  const list = rows.map(litterFromRow);
  store.getDb().litter = list;
  return list;
}

/** Demo reset: forget all litter; the next listLitter() carries over the fresh demo litter. */
export async function resetLitter() {
  if (!tiger()) return;
  await sql('DELETE FROM litter');
  seededTiger = false;
  await listLitter();
}

export async function getLitter(no) {
  if (!tiger()) return store.getDb().litter.find((l) => String(l.no) === String(no) || l.id === no) || null;
  const { rows } = await sql('SELECT * FROM litter WHERE no = $1', [Number(no) || 0]);
  return rows[0] ? litterFromRow(rows[0]) : null;
}

async function insertLitter(l) {
  const { rows } = await sql(`INSERT INTO litter (id, lat, lng, items, summary, photo, status, reporter_id, at, last_seen, checks)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
  [l.id, l.lat, l.lng, JSON.stringify(l.items), l.summary, l.photo, l.status || 'reported', l.reporterId || null, l.at || now(), l.lastSeen || l.at || now(), JSON.stringify(l.checks || [])]);
  return litterFromRow(rows[0]);
}

export async function addLitter({ lat, lng, items, summary = '', photo = null, reporterId = null }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('Location needed to put litter on the map');
  if (store.inPrivacyZone(lat, lng)) throw bad('That spot is inside a privacy zone');
  if (!tiger()) return store.addLitter({ lat, lng, items: cleanItems(items), summary, photo: cleanPhoto(photo), reporterId, status: 'reported' });
  const d = store.getDb().settings.locationDecimals;
  const l = await insertLitter({ id: rid('lt'), lat: round(lat, d), lng: round(lng, d), items: cleanItems(items), summary: String(summary).slice(0, 200), photo: cleanPhoto(photo), reporterId });
  await listLitter();
  return l;
}

/** Litter still on the map within `radius` metres, nearest first. */
export async function nearbyLitter(lat, lng, radius = 25) {
  return (await listLitter()).filter((l) => l.status === 'reported')
    .map((l) => ({ ...l, distance: haversine({ lat, lng }, l) })).filter((l) => l.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/**
 * A rider passing by answers "is it still there?".
 * answer: still | gone | picked. Two "gone" answers since it was last seen (or the reporter
 * saying so, or someone picking it up) take it off the map.
 */
export async function checkLitter(no, answer, by) {
  const l = await getLitter(no);
  if (!l) throw bad('Litter report not found', 404);
  if (!['still', 'gone', 'picked'].includes(answer)) throw bad('answer must be still, gone or picked');
  const wasReported = l.status === 'reported';
  const at = now();
  l.checks = [...(l.checks || []), { at, answer, by: by || 'anon' }].slice(-30);
  if (answer === 'still') l.lastSeen = at;
  const seen = l.lastSeen || l.at;
  const goneSinceSeen = l.checks.filter((c) => c.answer === 'gone' && c.at >= seen).length;
  if (l.status === 'reported' && (answer === 'picked' || goneSinceSeen >= 2 || (answer === 'gone' && by && by === l.reporterId))) {
    l.status = 'cleared';
    l.clearedAt = at;
  }
  if (tiger()) {
    await sql('UPDATE litter SET checks = $2, last_seen = $3, status = $4, cleared_at = $5 WHERE no = $1',
      [l.no, JSON.stringify(l.checks), l.lastSeen, l.status, l.clearedAt]);
    await listLitter();
  } else {
    Object.assign(store.getDb().litter.find((x) => x.no === l.no), l);
    if (l.status === 'cleared' && answer === 'picked') store.getDb().pickups.push({ at, count: Math.max(1, l.items.length), materials: l.items.map((i) => i.material) });
    store.save();
  }
  if (wasReported && l.status === 'cleared') {
    // Off the map: write it to the public record on Solana and reward the riders who helped.
    await chain.litterEvent(l, answer === 'picked' ? 'picked' : 'gone', by && by !== 'anon' ? by : null)
      .catch((e) => console.error('chain record', e.message));
  }
  return l;
}

// ---------------------------------------------------------------- ESP32-CAM devices

const deviceFromRow = (r) => ({ deviceId: r.device_id, userId: r.user_id, linkedAt: iso(r.linked_at), lastFrameAt: iso(r.last_frame_at), lastResult: r.last_result || null });

export async function linkDevice(uid, deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(id)) throw bad('Enter the camera ID shown in the Serial Monitor, like cam-7f3a');
  if (tiger()) {
    const { rows } = await sql('SELECT user_id FROM cam_devices WHERE device_id = $1', [id]);
    if (rows[0]?.user_id && rows[0].user_id !== uid) throw bad('That camera is linked to another rider', 409);
    await sql(`INSERT INTO cam_devices (device_id, user_id, linked_at) VALUES ($1,$2,now())
      ON CONFLICT (device_id) DO UPDATE SET user_id = $2, linked_at = now()`, [id, uid]);
  } else {
    const db = mem();
    let d = db.devices.find((x) => x.deviceId === id);
    if (d?.userId && d.userId !== uid) throw bad('That camera is linked to another rider', 409);
    if (!d) db.devices.push((d = { deviceId: id }));
    Object.assign(d, { userId: uid, linkedAt: now() });
    store.save();
  }
  return id;
}

export async function unlinkDevice(uid, deviceId) {
  if (tiger()) await sql('UPDATE cam_devices SET user_id = NULL WHERE device_id = $1 AND user_id = $2', [deviceId, uid]);
  else {
    const d = mem().devices.find((x) => x.deviceId === deviceId && x.userId === uid);
    if (d) d.userId = null;
    store.save();
  }
}

export async function listDevices(uid) {
  if (tiger()) return (await sql('SELECT device_id, user_id, linked_at, last_frame_at, last_result FROM cam_devices WHERE user_id = $1', [uid])).rows.map(deviceFromRow);
  return mem().devices.filter((d) => d.userId === uid).map(({ lastFrame, ...d }) => d);
}

/** The scooter unit's live state: { rideId, lastAt, label, speed, pm25, lat, lng, mags }. */
export async function getDeviceLive(deviceId) {
  if (tiger()) return (await sql('SELECT live FROM cam_devices WHERE device_id = $1', [deviceId])).rows[0]?.live || null;
  return mem().devices.find((x) => x.deviceId === deviceId)?.live || null;
}

export async function setDeviceLive(deviceId, live) {
  if (tiger()) return sql('UPDATE cam_devices SET live = $2 WHERE device_id = $1', [deviceId, JSON.stringify(live)]);
  const d = mem().devices.find((x) => x.deviceId === deviceId);
  if (d) { d.live = live; store.save(); }
}

/** Records a frame from a camera and returns the linked rider's id (or null if unlinked). */
export async function touchDevice(deviceId, frame, result) {
  if (tiger()) {
    const { rows } = await sql(`INSERT INTO cam_devices (device_id, last_frame_at, last_frame, last_result) VALUES ($1, now(), $2, $3)
      ON CONFLICT (device_id) DO UPDATE SET last_frame_at = now(), last_frame = COALESCE($2, cam_devices.last_frame), last_result = COALESCE($3, cam_devices.last_result)
      RETURNING user_id`, [deviceId, frame, result || null]);
    return rows[0]?.user_id || null;
  }
  const db = mem();
  let d = db.devices.find((x) => x.deviceId === deviceId);
  if (!d) db.devices.push((d = { deviceId, userId: null }));
  Object.assign(d, { lastFrameAt: now(), ...(frame ? { lastFrame: frame } : {}), ...(result ? { lastResult: result } : {}) });
  store.save();
  return d.userId || null;
}

export async function setDeviceResult(deviceId, result) {
  if (tiger()) await sql('UPDATE cam_devices SET last_result = $2 WHERE device_id = $1', [deviceId, result]);
  else {
    const d = mem().devices.find((x) => x.deviceId === deviceId);
    if (d) d.lastResult = result;
    store.save();
  }
}

export async function lastFrame(uid, deviceId) {
  if (tiger()) {
    const { rows } = await sql('SELECT last_frame FROM cam_devices WHERE device_id = $1 AND user_id = $2', [deviceId, uid]);
    return rows[0]?.last_frame || null;
  }
  return mem().devices.find((d) => d.deviceId === deviceId && d.userId === uid)?.lastFrame || null;
}

// ---------------------------------------------------------------- rider presence (where to pin camera finds)

export async function setPresence(uid, lat, lng) {
  if (!uid || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  if (tiger()) await sql(`INSERT INTO user_presence (user_id, lat, lng, at) VALUES ($1,$2,$3,now())
    ON CONFLICT (user_id) DO UPDATE SET lat = $2, lng = $3, at = now()`, [uid, lat, lng]);
  else { mem().presence[uid] = { lat, lng, at: now() }; store.save(); }
}

/** Last known position if it is fresh enough to pin litter on. */
export async function getPresence(uid, maxAgeMs = 180_000) {
  let p;
  if (tiger()) p = (await sql('SELECT lat, lng, at FROM user_presence WHERE user_id = $1', [uid])).rows[0];
  else p = mem().presence[uid];
  return p && Date.now() - new Date(p.at).getTime() <= maxAgeMs ? { lat: p.lat, lng: p.lng, at: iso(p.at) } : null;
}

// ---------------------------------------------------------------- detections

const detFromRow = (r) => ({
  id: r.id, userId: r.user_id, deviceId: r.device_id, time: iso(r.time), status: r.status, items: r.items || [], summary: r.summary || '',
  idea: r.idea || null, photo: r.photo, lat: r.lat, lng: r.lng, litterNo: r.litter_no, resolvedAt: iso(r.resolved_at),
});

export async function createDetection({ uid, deviceId = null, items, summary, idea = null, photo = null, lat = null, lng = null }) {
  const pos = Number.isFinite(lat) ? { lat, lng } : await getPresence(uid);
  const known = pos ? (await nearbyLitter(pos.lat, pos.lng, 25))[0] : null;
  const d = { id: rid('det'), userId: uid, deviceId, time: now(), status: 'pending', items: cleanItems(items), summary: String(summary || '').slice(0, 200),
    idea, photo: cleanPhoto(photo), lat: pos?.lat ?? null, lng: pos?.lng ?? null, litterNo: known?.no ?? null };
  if (tiger()) {
    await sql(`INSERT INTO trash_detections (id, user_id, device_id, items, summary, idea, photo, lat, lng, litter_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [d.id, uid, deviceId, JSON.stringify(d.items), d.summary, idea ? JSON.stringify(idea) : null, d.photo, d.lat, d.lng, d.litterNo]);
  } else {
    mem().detections.push(d);
    store.save();
  }
  return d;
}

export async function pendingDetections(uid) {
  if (tiger()) {
    const { rows } = await sql(`SELECT * FROM trash_detections WHERE user_id = $1 AND status = 'pending' AND time > now() - interval '30 minutes' ORDER BY time`, [uid]);
    return rows.map(detFromRow);
  }
  const cutoff = Date.now() - 30 * 60_000;
  return mem().detections.filter((d) => d.userId === uid && d.status === 'pending' && Date.parse(d.time) > cutoff);
}

export async function getDetection(uid, id) {
  if (tiger()) {
    const { rows } = await sql('SELECT * FROM trash_detections WHERE id = $1 AND user_id = $2', [id, uid]);
    return rows[0] ? detFromRow(rows[0]) : null;
  }
  return mem().detections.find((d) => d.id === id && d.userId === uid) || null;
}

export async function finishDetection(id, status, litterNo = null) {
  if (tiger()) await sql('UPDATE trash_detections SET status = $2, resolved_at = now(), litter_no = COALESCE($3, litter_no) WHERE id = $1', [id, status, litterNo]);
  else {
    const d = mem().detections.find((x) => x.id === id);
    if (d) Object.assign(d, { status, resolvedAt: now(), litterNo: litterNo ?? d.litterNo });
    store.save();
  }
}

// ---------------------------------------------------------------- trash list

export async function addUserTrash(uid, items, photo, source) {
  const rows = cleanItems(items).map((i) => ({ id: rid('tr'), userId: uid, time: now(), name: i.name, material: i.material, photo: cleanPhoto(photo), source }));
  if (tiger()) {
    for (const r of rows) await sql('INSERT INTO user_trash (id, user_id, name, material, photo, source) VALUES ($1,$2,$3,$4,$5,$6)', [r.id, uid, r.name, r.material, r.photo, source]);
  } else {
    mem().userTrash.push(...rows);
    store.save();
  }
  return rows;
}

export async function listUserTrash(uid) {
  if (tiger()) {
    const { rows } = await sql('SELECT id, time, name, material, photo, source FROM user_trash WHERE user_id = $1 ORDER BY time DESC LIMIT 100', [uid]);
    return rows.map((r) => ({ ...r, time: iso(r.time) }));
  }
  return mem().userTrash.filter((t) => t.userId === uid).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 100);
}

export async function deleteUserTrash(uid, id) {
  if (tiger()) await sql('DELETE FROM user_trash WHERE id = $1 AND user_id = $2', [id, uid]);
  else {
    const db = mem();
    db.userTrash = db.userTrash.filter((t) => !(t.id === id && t.userId === uid));
    store.save();
  }
}
