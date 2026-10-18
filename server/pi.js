// The Raspberry Pi scooter unit: real readings in, a live ride out.
//
//   Pi ──JSON──▶ POST /api/device/readings   motion windows (IMU), air (gas level or PM2.5), GPS if it has one
//   phone ──────▶ GET /api/device/live?lat&lng&speed   the location for those readings
//                       │  classify each 0.5 s window, add to the rider's ride (Tiger)
//   phone ◀── GET /api/device/live?after=…    new windows, ride totals, device status
//
// Every request stands alone (the Pi groups its samples into whole windows), so it works on
// Vercel where each request may reach a different server instance. A ride starts with the
// first reading and ends after RIDE_GAP_MS without one.
import * as store from './store.js';
import * as users from './userdb.js';
import * as trash from './trashdb.js';
import * as persist from './persist.js';
import { extractFeatures, CLASS_INFO, POTHOLE_G as DEFAULT_POTHOLE_G } from '../shared/signal.js';
import { classify } from '../shared/classifier.js';

const RIDE_GAP_MS = 90_000;
const POTHOLE_G = Number(process.env.POTHOLE_G) || DEFAULT_POTHOLE_G;

/**
 * The scooter unit's rule: a jolt past the threshold is a pothole, and nothing under it is.
 * Below the threshold the classifier still tells smooth, seams and rough surface apart.
 */
export function potholeRule(f, pred) {
  if (f.maxDev >= POTHOLE_G) {
    const confidence = Math.min(0.99, 0.8 + (f.maxDev - POTHOLE_G) / 2);
    return { label: 'bump', confidence, probs: { bump: confidence, rough: 0, joint: 0, smooth: 1 - confidence }, model: 'threshold',
      reasons: [`Jolt of ${f.maxDev.toFixed(2)} g is past the ${POTHOLE_G} g pothole threshold`] };
  }
  if (pred.label !== 'bump') return pred;
  const probs = { ...pred.probs, bump: 0 };
  const sum = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
  for (const k in probs) probs[k] /= sum;
  const label = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
  return { ...pred, label, confidence: probs[label], probs,
    reasons: [`Jolt of ${f.maxDev.toFixed(2)} g is under the ${POTHOLE_G} g pothole threshold`] };
}
const ONLINE_MS = 15_000;
/** A parked sensor checks in every 15 s with no motion; this long without any message means it is off. */
const SEEN_MS = 40_000;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** True while the rider has a litter alert they have not answered: the camera should not send photos. */
const camBusy = async (uid) => (await trash.pendingDetections(uid)).length > 0;
const watch = (deviceId) => trash.isWatched(deviceId);

/** Close a ride and credit its kilometres to the rider. */
async function endRide(ride, at) {
  if (!ride || ride.endedAt) return;
  ride.endedAt = at || new Date().toISOString();
  store.save();
  if (ride.userId) {
    await users.recordActivity(ride.userId, 'ride_km', ride.distanceM / 1000, { rideId: ride.id }).catch(() => {});
    if (ride.hazardHits) await users.recordActivity(ride.userId, 'hazard_hits', ride.hazardHits, { rideId: ride.id }).catch(() => {});
  }
}

function toWindows(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((w) => {
    const rows = Array.isArray(w?.samples) ? w.samples : Array.isArray(w) ? w : [];
    const samples = rows.slice(0, 200).map((r) => ({ t: num(r[0]), ax: num(r[1]), ay: num(r[2]), az: num(r[3]), gx: num(r[4]), gy: num(r[5]), gz: num(r[6]) }))
      .filter((s) => [s.t, s.ax, s.ay, s.az].every(Number.isFinite));
    return samples.length >= 8 ? samples : null;
  }).filter(Boolean);
}

export function mountPi(app) {
  // ---------------------------------------------------------------- readings from the Pi
  app.post('/api/device/readings', async (req, res) => {
    const token = process.env.INGEST_TOKEN;
    if (token && req.get('x-scootsense-token') !== token) throw bad('Bad token', 401);
    const b = req.body || {};
    const deviceId = String(b.device || '').trim().toLowerCase().slice(0, 40);
    if (!/^[a-z0-9-]{3,40}$/.test(deviceId)) throw bad('Send "device": the scooter unit ID, like cam-7f3a');

    const windows = toWindows(b.windows);
    let gps = b.gps && num(b.gps.lat) !== null && num(b.gps.lng) !== null
      ? { lat: num(b.gps.lat), lng: num(b.gps.lng), speed: num(b.gps.speed) } : null;
    const pm25 = num(b.pm25);
    // Grove Air Quality v1.3 (gas sensor, not PM2.5): a 0-1023 reading and a level.
    const AIR_LEVELS = ['fresh', 'low', 'high', 'severe'];
    const air = b.airQuality && AIR_LEVELS.includes(b.airQuality.level)
      ? { gas: num(b.airQuality.raw), airLevel: b.airQuality.level } : null;

    const owner = await trash.touchDevice(deviceId, null, null);
    if (!owner) return res.json({ paired: false, message: `Link "${deviceId}" in the ScootSense app: Scan tab, Scooter camera, Link.` });
    if (!windows.length) {
      // Parked: no motion to classify, but the sensor is on. Note the time (and the air) without touching the ride.
      const live = (await trash.getDeviceLive(deviceId)) || {};
      await trash.setDeviceLive(deviceId, { ...live, seenAt: new Date().toISOString(),
        ...(air ? { airLevel: air.airLevel, gas: air.gas } : {}), ...(pm25 !== null ? { pm25 } : {}) });
      return res.json({ paired: true, windows: 0, camBusy: await camBusy(owner), watch: await watch(deviceId) });
    }
    // No GPS on the sensor: use the rider's phone, which reports its position every second during a ride.
    if (!gps) {
      const p = await trash.getPresence(owner, 10_000);
      if (p) gps = { lat: p.lat, lng: p.lng, speed: p.speed ?? null };
    }

    const live = (await trash.getDeviceLive(deviceId)) || {};
    const now = Date.now();
    let ride = live.rideId ? store.getRide(live.rideId) : null;
    if (!ride || ride.endedAt || now - Date.parse(live.lastAt || 0) > RIDE_GAP_MS) {
      await endRide(ride, live.lastAt);
      ride = store.createRide({ name: `Ride ${new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`, source: 'pi', device: deviceId, userId: owner });
    }

    // Classify each window; the Pi's clock gives the spacing, the server's gives the date.
    const lastT = windows.at(-1).at(-1).t;
    const observations = windows.map((samples) => {
      const t1 = samples.at(-1).t;
      const features = extractFeatures(samples);
      const pred = potholeRule(features, classify(features, store.getDb().model));
      return { t: t1, at: new Date(now - Math.max(0, lastT - t1)).toISOString(), lat: gps?.lat ?? null, lng: gps?.lng ?? null,
        speed: gps?.speed ?? null, pm25, features: { ...features, ...(air || {}) }, ...pred };
    });
    const out = store.addObservations(ride.id, observations);

    const last = observations.at(-1);
    const lastSamples = windows.at(-1);
    await trash.setDeviceLive(deviceId, {
      rideId: ride.id, lastAt: new Date(now).toISOString(), seenAt: new Date(now).toISOString(), label: last.label, confidence: last.confidence, airLevel: air?.airLevel ?? null, gas: air?.gas ?? null,
      speed: gps?.speed ?? null, pm25, lat: gps?.lat ?? null, lng: gps?.lng ?? null,
      mags: lastSamples.map((s) => +Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az).toFixed(3)),
    });
    res.json({ paired: true, camBusy: await camBusy(owner), watch: await watch(deviceId), rideId: ride.id, windows: observations.length, bumps: observations.filter((o) => CLASS_INFO[o.label]?.hazard).length,
      hazards: out.hazards.map((h) => `H${h.no}`) });
  });

  // ---------------------------------------------------------------- the rider's live screen
  app.get('/api/device/live', async (req, res) => {
    const uid = req.session?.uid;
    if (!uid) return res.json({ device: null });
    // The phone's position and speed (km/h): the location for the sensor's readings.
    const lat = num(req.query.lat), lng = num(req.query.lng);
    if (lat !== null && lng !== null) await trash.setPresence(uid, lat, lng, num(req.query.speed));
    const devices = await trash.listDevices(uid);
    if (!devices.length) return res.json({ device: null });
    // The unit that reported most recently.
    const lives = await Promise.all(devices.map(async (d) => ({ d, live: await trash.getDeviceLive(d.deviceId) })));
    const seenOf = (l) => Math.max(Date.parse(l?.lastAt || 0) || 0, Date.parse(l?.seenAt || 0) || 0);
    lives.sort((a, b) => seenOf(b.live) - seenOf(a.live));
    const { d, live } = lives[0];
    const lastAt = live?.lastAt ? Date.parse(live.lastAt) : 0;
    const moving = Date.now() - lastAt < ONLINE_MS;            // sending motion right now
    const online = moving || Date.now() - seenOf(live) < SEEN_MS; // switched on (moving or parked)
    let ride = live?.rideId ? store.getRide(live.rideId) : null;
    if (ride && !ride.endedAt && Date.now() - lastAt > RIDE_GAP_MS) {
      await endRide(ride, live.lastAt);
      await persist.persist(); // a GET is not saved automatically
    }

    const after = Date.parse(req.query.after || 0) || 0;
    const observations = ride ? store.getDb().observations
      .filter((o) => o.rideId === ride.id && Date.parse(o.at) > after).slice(-40)
      .map((o) => ({ at: o.at, t: o.t, lat: o.lat, lng: o.lng, speed: o.speed, pm25: o.pm25, label: o.label, confidence: o.confidence, model: o.model, score: o.score, f: o.f })) : [];
    const hazards = ride ? store.listHazards().filter((h) => h.rideIds.includes(ride.id) && Date.parse(h.lastSeen) > after) : [];
    res.json({
      device: d.deviceId, online, moving, lastAt: live?.lastAt || null, seenAt: live?.seenAt || null,
      ride: ride ? { id: ride.id, name: ride.name, startedAt: ride.startedAt, endedAt: ride.endedAt, distanceM: ride.distanceM, observations: ride.observations, hazardHits: ride.hazardHits } : null,
      now: { label: live?.label || null, speed: live?.speed ?? null, pm25: live?.pm25 ?? null, airLevel: online ? live?.airLevel ?? null : null, gas: online ? live?.gas ?? null : null, lat: live?.lat ?? null, lng: live?.lng ?? null, mags: moving ? live?.mags || [] : [] },
      observations, hazards,
    });
  });
}
