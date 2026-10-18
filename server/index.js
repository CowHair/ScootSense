import { config, isServerless } from './config.js';
import { mountMapCompletions } from './map-completions.js';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';
import * as gemini from './gemini.js';
import { seedDemo } from './seed.js';
import * as users from './userdb.js';
import * as persist from './persist.js';
import { sessionMiddleware, mountAuth } from './auth.js';
import { mountCamera } from './camera.js';
import { listLitter, resetLitter } from './trashdb.js';
import * as coach from './coach.js';
import * as chain from './chain.js';
import { mountPi } from './pi.js';
import { mountRoutes } from './routes.js';
import { mountSpots } from './spots.js';
import { Windower, extractFeatures, sampleFromArray, CLASS_INFO } from '../shared/signal.js';
import { classify } from '../shared/classifier.js';

const app = express();
const PORT = Number(config.PORT) || 3000;
const ROOT = path.resolve(import.meta.dirname, '..');
const PHOTO_DIR = path.join(store.DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// With Tiger connected, persist.ensureFresh() loads (or seeds) the data on the first request.
if (users.backend() === 'local' && !store.getDb().rides.length) {
  console.log('Empty database: seeding demo rides around UTSC…');
  seedDemo();
}

app.use(express.json({ limit: '12mb' }));
app.use(sessionMiddleware);
const noCache = { setHeaders: (res) => res.set('Cache-Control', 'no-cache') };
app.use(express.static(path.join(ROOT, 'public'), noCache));
app.use('/shared', express.static(path.join(ROOT, 'shared'), noCache));
app.use('/photos', express.static(PHOTO_DIR));
app.get('/firmware/scootsense.ino', (_req, res) => res.sendFile(path.join(ROOT, 'firmware', 'scootsense', 'scootsense.ino')));
app.get('/firmware/scootsense_cam.ino', (_req, res) => res.sendFile(path.join(ROOT, 'firmware', 'scootsense_cam', 'scootsense_cam.ino')));
app.get('/firmware/scootsense_unit.py', (_req, res) => res.type('text/x-python').sendFile(path.join(ROOT, 'firmware', 'raspberry_pi', 'scootsense_unit.py')));

const db = store.getDb;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const uid = (req) => req.session?.uid || null;
const actor = (req) => req.session?.uid || req.session?.gid || null;

// Community data lives in Tiger: catch up with other instances before each API call, and
// save what a write changed before replying (Vercel may freeze the function right after).
app.use('/api', async (req, res, next) => {
  try { await persist.ensureFresh(); } catch (e) { console.error('tiger load', e.message); }
  if (req.method !== 'GET') {
    const json = res.json.bind(res);
    res.json = (body) => {
      if(req.mapCompletion) return json(body);
      persist.persist().catch((e) => console.error('tiger save', e.message)).finally(() => json(body));
      return res;
    };
  }
  next();
});

mountAuth(app);
mountCamera(app);
chain.mountChain(app);
mountPi(app);
mountSpots(app);
mountRoutes(app);
mountMapCompletions(app);

/** Write a hazard to the public record on Solana when the community confirms it or it gets fixed. */
async function recordHazard(h, before) {
  try {
    if (h.status === 'confirmed' && before !== 'confirmed') await chain.hazardEvent(h, 'confirmed');
    if (h.status === 'fixed' && before !== 'fixed') await chain.hazardEvent(h, 'fixed');
  } catch (e) {
    console.error('chain record', e.message);
  }
}

// Litter is shared through Tiger; refresh the in-memory copy before anything that summarises it.
const freshLitter = () => listLitter().catch((e) => console.error('litter refresh', e.message));

// ---------------------------------------------------------------- status & settings

app.get('/api/status', (_req, res) => {
  res.json({ gemini: gemini.geminiStatus(), stats: store.stats(), lanUrls: lanUrls(), settings: db().settings, liveDevices: [...devices.keys()] });
});

app.patch('/api/settings', (req, res) => {
  const s = db().settings;
  if (req.body.locationDecimals !== undefined) s.locationDecimals = Math.min(6, Math.max(3, Number(req.body.locationDecimals)));
  if (Array.isArray(req.body.privacyZones)) {
    s.privacyZones = req.body.privacyZones
      .filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lng))
      .map((z) => ({ lat: z.lat, lng: z.lng, radius: Math.min(1000, Math.max(50, Number(z.radius) || 150)) }));
  }
  store.save();
  res.json(s);
});

// ---------------------------------------------------------------- rides & observations

app.get('/api/rides', (_req, res) => res.json([...db().rides].reverse()));

app.post('/api/rides', (req, res) => {
  // Simulated rides stay in the demo; the shared map only gets real sensor data.
  if (req.body?.source === 'sim' || req.session?.demo) throw bad('Simulated rides are not saved to the map', 403);
  res.json(store.createRide({ ...(req.body || {}), userId: uid(req) }));
});

app.patch('/api/rides/:id', async (req, res) => {
  const ride = store.getRide(req.params.id);
  if (!ride) throw bad('Ride not found', 404);
  if (req.body.name) ride.name = String(req.body.name).slice(0, 80);
  if (req.body.end && !ride.endedAt) {
    ride.endedAt = new Date().toISOString();
    if (ride.userId && ride.userId === uid(req)) {
      await users.recordActivity(ride.userId, 'ride_km', ride.distanceM / 1000, { rideId: ride.id });
      if (ride.hazardHits) await users.recordActivity(ride.userId, 'hazard_hits', ride.hazardHits, { rideId: ride.id });
    }
  }
  store.save();
  res.json(ride);
});

app.delete('/api/rides/:id', (req, res) => {
  store.deleteRide(req.params.id);
  res.json({ ok: true });
});

app.post('/api/rides/:id/observations', async (req, res) => {
  const list = Array.isArray(req.body.observations) ? req.body.observations : [];
  const out = store.addObservations(req.params.id, list);
  res.json({ stored: out.stored, hazards: out.hazards.map(store.hazardView) });
});

app.get('/api/rides/:id/track', (req, res) => {
  res.json(db().observations.filter((o) => o.rideId === req.params.id && o.lat !== null)
    .map((o) => [o.lat, o.lng, o.score, o.label]));
});

app.get('/api/observations', (req, res) => {
  const limit = Math.min(20000, Number(req.query.limit) || 8000);
  const geo = db().observations.filter((o) => o.lat !== null);
  res.json(geo.slice(-limit).map((o) => [o.lat, o.lng, o.score, o.label]));
});

app.get('/api/grid', (_req, res) => res.json(store.roughnessGrid()));
app.get('/api/stats', async (_req, res) => { await freshLitter(); res.json(store.stats()); });

// ---------------------------------------------------------------- hazards

app.get('/api/hazards', (req, res) => {
  res.json(store.listHazards({ status: req.query.status, minReports: Number(req.query.minReports) || 1 }));
});

app.get('/api/hazards/:id', (req, res) => {
  const h = store.getHazard(req.params.id);
  if (!h) throw bad('Hazard not found', 404);
  res.json(h);
});

app.post('/api/hazards/:id/vote', async (req, res) => {
  if (!['confirm', 'dismiss', 'fixed'].includes(req.body.vote)) throw bad('vote must be confirm, dismiss or fixed');
  const before = store.rawHazard(req.params.id)?.status;
  const h = store.voteHazard(req.params.id, req.body.vote, actor(req));
  if (h && uid(req)) await users.recordActivity(uid(req), 'vote', 1, { hazard: h.no, vote: req.body.vote });
  if (!h) throw bad('Hazard not found', 404);
  await recordHazard(store.rawHazard(req.params.id), before);
  res.json(h);
});

app.post('/api/hazards/:id/notes', (req, res) => {
  const h = store.rawHazard(req.params.id);
  if (!h) throw bad('Hazard not found', 404);
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) throw bad('Empty note');
  h.notes.push({ at: new Date().toISOString(), text });
  store.save();
  res.json(store.hazardView(h));
});

app.post('/api/hazards/:id/photo', async (req, res) => {
  let h = store.rawHazard(req.params.id);
  if (!h) throw bad('Hazard not found', 404);
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(req.body.image || '');
  if (!m) throw bad('Send a JPEG, PNG or WebP data URL');
  const [, mimeType, ext, data] = m;
  const analysis = await gemini.analyzePhoto({ imageBase64: data, mimeType, hazard: store.hazardView(h) });
  h = store.rawHazard(req.params.id) || h; // the store may have been refreshed from Tiger meanwhile
  const photo = { id: store.id('ph'), at: new Date().toISOString(), analysis, src: null, by: actor(req) };
  // Respect privacy: keep the image only if Gemini saw no faces / plates.
  if (analysis.privacyConcern !== true) {
    if (users.backend() === 'tiger') {
      await users.sql('INSERT INTO city.hazard_photos (id, hazard_id, mime, image) VALUES ($1, $2, $3, $4)',
        [photo.id, h.id, mimeType, Buffer.from(data, 'base64')]);
      photo.src = `/api/photos/${photo.id}`;
    } else {
      photo.file = `${photo.id}.${ext === 'jpeg' ? 'jpg' : ext}`;
      fs.writeFileSync(path.join(PHOTO_DIR, photo.file), Buffer.from(data, 'base64'));
      photo.src = `/photos/${photo.file}`;
    }
  }
  h.photos.push(photo);
  // A confident photo confirmation counts as one community confirmation.
  const before = h.status;
  if (analysis.source === 'gemini' && analysis.isRoadDefect && analysis.confidence >= 0.7) {
    h.votes.confirm++;
    if (h.votes.confirm > h.votes.dismiss) h.status = 'confirmed';
  }
  await recordHazard(h, before);
  store.save();
  res.json({ hazard: store.hazardView(h), photo });
});

app.get('/api/db', async (_req, res) => {
  res.json({ ...(await users.health()), schemas: await users.layout() });
});

app.get('/api/photos/:id', async (req, res) => {
  const { rows } = await users.sql('SELECT mime, image FROM city.hazard_photos WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw bad('Photo not found', 404);
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'public, max-age=31536000, immutable' }).send(rows[0].image);
});

// ---------------------------------------------------------------- model & training data

app.get('/api/model', (_req, res) => res.json(db().model));
app.post('/api/model', (req, res) => {
  if (req.body?.type !== 'gnb') throw bad('Only gnb models are supported');
  db().model = req.body;
  store.save();
  res.json({ ok: true });
});
app.delete('/api/model', (_req, res) => { db().model = null; store.save(); res.json({ ok: true }); });

app.get('/api/training', (_req, res) => res.json(db().trainingSamples));
app.post('/api/training', (req, res) => {
  const list = (req.body.samples || []).filter((s) => CLASS_INFO[s.label] && s.features);
  for (const s of list) {
    db().trainingSamples.push({ id: store.id('ts'), label: s.label, recordingId: s.recordingId || 'manual',
      features: s.features, source: s.source || 'device', at: new Date().toISOString() });
  }
  store.save();
  res.json({ added: list.length, total: db().trainingSamples.length });
});
app.delete('/api/training', (req, res) => {
  const rec = req.query.recordingId;
  db().trainingSamples = rec ? db().trainingSamples.filter((s) => s.recordingId !== rec) : [];
  store.save();
  res.json({ total: db().trainingSamples.length });
});

// ---------------------------------------------------------------- Gemini

app.get('/api/ai/status', (_req, res) => res.json(gemini.geminiStatus()));
app.post('/api/ai/report', async (req, res) => { await freshLitter(); res.json(await gemini.cityReport(req.body || {})); });
app.get('/api/ai/image-models', async (_req, res) => res.json(await gemini.imageModels().catch((e) => ({ error: e.message }))));
app.post('/api/ai/project-image', async (req, res) => {
  if (!req.body?.idea?.title) throw bad('idea required');
  res.json(await coach.projectImage(req.body.idea));
});
app.post('/api/ai/chat', async (req, res) => {
  await freshLitter();
  if (!req.body?.message) throw bad('message required');
  return res.json(await coach.chat({ message: req.body.message, history: req.body.history || [], uid: uid(req),
    who: req.session?.uid || req.session?.gid || null, clientStash: Array.isArray(req.body.stash) ? req.body.stash.slice(0, 40) : [] }));
});
app.post('/api/ai/ride-summary/:id', async (req, res) => {
  const out = await gemini.rideSummary(req.params.id);
  if (!out) throw bad('Ride not found', 404);
  const ride = store.getRide(req.params.id);
  ride.summary = out.text;
  store.save();
  res.json(out);
});
app.post('/api/ai/second-opinion', async (req, res) => res.json(await gemini.secondOpinion(req.body)));

// ---------------------------------------------------------------- trash scanner, upcycling, litter & air

function parseImage(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw bad('Send a JPEG, PNG or WebP data URL');
  return { mimeType: m[1], ext: m[2] === 'jpeg' ? 'jpg' : m[2], data: m[3] };
}

const cleanInventory = (inv) => (Array.isArray(inv) ? inv : []).slice(0, 60)
  .map((i) => ({ name: String(i.name || '').slice(0, 60), material: String(i.material || '').slice(0, 30), qty: Number(i.qty) || 1 }))
  .filter((i) => i.name);

app.post('/api/ai/scan', async (req, res) => {
  const inventory = cleanInventory(req.body.inventory);
  if (req.body.demo) {
    const item = gemini.DEMO_TRASH[Math.floor(Math.random() * gemini.DEMO_TRASH.length)];
    const { idea, source } = await gemini.upcycleIdea({ items: [item], inventory });
    return res.json({ trashDetected: true, confidence: 0.9, items: [{ ...item, pickupSafe: true }], summary: `${item.name[0].toUpperCase() + item.name.slice(1)} on the path ahead`,
      pollutionVisible: 'none', roadHazardVisible: 'none', idea, source, demo: true });
  }
  const img = parseImage(req.body.image);
  try {
    res.json(await gemini.scanTrash({ imageBase64: img.data, mimeType: img.mimeType, inventory }));
  } catch (e) {
    res.json({ trashDetected: false, items: [], summary: '', source: 'fallback',
      error: e.fallback ? 'Gemini is not configured, so camera detection is off. Use “Simulate trash” to try the flow.' : String(e.message).slice(0, 200) });
  }
});

app.post('/api/ai/upcycle', async (req, res) => {
  res.json(await gemini.upcycleIdea({ items: Array.isArray(req.body.items) ? req.body.items.slice(0, 5) : [], inventory: cleanInventory(req.body.inventory) }));
});

app.post('/api/ai/inventory-scan', async (req, res) => {
  const img = parseImage(req.body.image);
  try {
    res.json(await gemini.scanInventory({ imageBase64: img.data, mimeType: img.mimeType }));
  } catch (e) {
    throw bad(e.fallback ? 'Gemini is not configured. Add items by hand instead.' : 'Gemini could not read that photo', 503);
  }
});

app.get('/api/pollution', (_req, res) => res.json(store.pollutionHotspots()));

// ---------------------------------------------------------------- Wi-Fi streaming from the ESP32

const devices = new Map(); // deviceId -> { windower, rideId, lastAt }
const clients = new Set();

app.get('/api/live', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', devices: [...devices.keys()] })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) c.write(line);
}

app.post('/api/ingest', (req, res) => {
  const token = config.INGEST_TOKEN;
  if (token && req.get('x-scootsense-token') !== token) throw bad('Bad token', 401);
  const deviceId = String(req.body.device || 'esp32');
  const rows = Array.isArray(req.body.samples) ? req.body.samples : [];
  let dev = devices.get(deviceId);
  if (!dev || Date.now() - dev.lastAt > 60_000 || !store.getRide(dev.rideId)) {
    if (dev) { const old = store.getRide(dev.rideId); if (old && !old.endedAt) old.endedAt = new Date().toISOString(); }
    const ride = store.createRide({ name: `Wi-Fi ride ${new Date().toLocaleString()}`, source: 'wifi', device: deviceId });
    dev = { windower: new Windower(), rideId: ride.id, lastAt: Date.now() };
    devices.set(deviceId, dev);
    broadcast({ type: 'ride', ride });
  }
  dev.lastAt = Date.now();
  const samples = rows.map((r) => (Array.isArray(r) ? sampleFromArray(r) : r)).filter((s) => Number.isFinite(s.t));
  const observations = [];
  for (const s of samples) {
    const w = dev.windower.push(s);
    if (!w) continue;
    const features = extractFeatures(w.samples);
    const pred = classify(features, db().model);
    observations.push({ t: w.t1, lat: w.lat, lng: w.lng, speed: w.speed, pm25: w.pm25, features, ...pred });
  }
  const out = observations.length ? store.addObservations(dev.rideId, observations) : { hazards: [] };
  broadcast({ type: 'batch', device: deviceId, rideId: dev.rideId, samples: samples.slice(-60), observations,
    hazards: out.hazards.map(store.hazardView) });
  res.json({ ok: true, rideId: dev.rideId, windows: observations.length });
});

// ---------------------------------------------------------------- exports & demo data

app.get('/api/export/hazards.geojson', async (_req, res) => {
  await freshLitter();
  res.set('Content-Disposition', 'attachment; filename="scootsense-hazards.geojson"');
  res.json({
    type: 'FeatureCollection',
    features: store.listHazards().filter((h) => h.status !== 'dismissed').map((h) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
      properties: { id: `H${h.no}`, type: h.typeLabel, severity: h.severity, priority: h.priority,
        independentRides: h.reports, status: h.status, confidence: h.confidence, firstSeen: h.firstSeen, lastSeen: h.lastSeen },
    })).concat(db().litter.filter((l) => l.status === 'reported').map((l) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
      properties: { id: `L${l.no}`, type: 'Litter', items: l.items.map((i) => i.name).join(', '), reportedAt: l.at },
    }))).concat(store.pollutionHotspots().map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { type: 'PM2.5 hotspot', pm25: c.pm25, windows: c.n },
    }))),
  });
});

app.get('/api/export/observations.csv', (_req, res) => {
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="scootsense-observations.csv"' });
  const head = 'ride_id,time,lat,lng,speed_kmh,pm25,label,confidence,model,score,std,max_dev,p2p,jerk,kurtosis,dom_freq,hf_ratio\n';
  res.send(head + db().observations.map((o) => [o.rideId, o.at, o.lat ?? '', o.lng ?? '', o.speed ?? '', o.pm25 ?? '', o.label, o.confidence, o.model, o.score,
    o.f.std, o.f.maxDev, o.f.p2p, o.f.jerk, o.f.kurtosis, o.f.domFreq, o.f.hfRatio].join(',')).join('\n'));
});

app.post('/api/demo/reset', async (req, res) => {
  store.reset();
  if (req.body?.seed !== false) seedDemo();
  await resetLitter();
  res.json(store.stats());
});

// ---------------------------------------------------------------- errors

app.use('/api', (_req, _res, next) => next(bad('Not found', 404)));
app.use((err, _req, res, _next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

function lanUrls() {
  if (isServerless) return [`https://${'scootsense.vercel.app'}`];
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${PORT}`);
}

export default app;

if (!isServerless) {
  process.on('SIGINT', () => { store.flush(); process.exit(0); });
  app.listen(PORT, '0.0.0.0', () => {
    const g = gemini.geminiStatus();
    console.log(`\n  ScootSense running at http://localhost:${PORT}`);
    lanUrls().forEach((u) => console.log(`  On your network:    ${u}   (use this for the ESP32 Wi-Fi mode / your phone)`));
    console.log(`  Gemini: ${g.enabled ? 'enabled (' + g.model + ')' : 'unavailable (app still works with local fallbacks)'}\n`);
  });
}
