// Scooter-camera litter detection and the shared litter map.
//
//  ESP32-CAM ──JPEG──▶ POST /api/cam/frame ──▶ Gemini (litter + project idea)
//  Raspberry Pi (detects on the Pi) ──JSON──▶ POST /api/cam/detection ──▶ Gemini (project idea, text only)
//                                                 │
//  rider's phone ◀── GET /api/cam/events (poll) ◀─┘ pending detection
//        │
//        └─▶ POST /api/detections/:id  pickup → trash list   |   map → litter pin
//
//  Anyone passing a pin later ──▶ POST /api/litter/:no/check  still | gone | picked
import express from 'express';
import * as gemini from './gemini.js';
import * as users from './userdb.js';
import * as trash from './trashdb.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const actor = (req) => req.session?.uid || req.session?.gid || null;
const member = (req) => req.session?.uid || null;
const needActor = (req) => { const a = actor(req); if (!a) throw bad('Sign in, or continue as a guest, first', 401); return a; };
const needMember = (req) => { const m = member(req); if (!m) throw bad('Sign in to use this', 401); return m; };
const MATERIALS = ['plastic', 'glass', 'metal', 'paper', 'cardboard', 'textile', 'organic', 'electronic', 'hazardous', 'mixed'];
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const litterSummary = ({ photo, checks, ...l }) => ({ ...l, hasPhoto: !!photo, checkCount: (checks || []).length });

export function mountCamera(app) {
  // ---------------------------------------------------------------- frames from the ESP32-CAM
  app.post('/api/cam/frame', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '3mb' }), async (req, res) => {
    const token = process.env.INGEST_TOKEN;
    if (token && req.get('x-scootsense-token') !== token) throw bad('Bad token', 401);
    const deviceId = String(req.query.device || req.get('x-device-id') || '').trim().toLowerCase().slice(0, 40);
    if (!deviceId) throw bad('Add ?device=<camera id> to the URL');
    const jpeg = req.body;
    if (!Buffer.isBuffer(jpeg) || jpeg.length < 500) throw bad('Send the JPEG frame as the request body (Content-Type: image/jpeg)');

    const preview = jpeg.length <= 110_000 ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
    const owner = await trash.touchDevice(deviceId, preview);
    if (!owner) return res.json({ paired: false, message: `Link camera "${deviceId}" in the ScootSense app: Scan tab, Link camera.` });

    // One question at a time: while the rider has an unanswered alert, keep streaming but skip Gemini.
    const pending = await trash.pendingDetections(owner);
    if (pending.length) return res.json({ paired: true, skipped: 'waiting for the rider to answer' });

    let r;
    try {
      r = await gemini.scanTrash({ imageBase64: jpeg.toString('base64'), mimeType: 'image/jpeg', inventory: await users.getStash(owner) });
    } catch (e) {
      const msg = e.fallback ? 'Gemini is not configured on the server' : String(e.message).slice(0, 120);
      await trash.setDeviceResult(deviceId, `error: ${msg}`);
      return res.json({ paired: true, trash: false, error: msg });
    }
    const found = r.trashDetected && r.items?.length && (r.confidence ?? 1) >= 0.5;
    await trash.setDeviceResult(deviceId, found ? `litter: ${r.summary}` : `clear: ${r.summary || 'nothing found'}`);
    if (!found) return res.json({ paired: true, trash: false, summary: r.summary });

    // A camera with its own GPS (e.g. a Raspberry Pi) can send ?lat=&lng=; otherwise the rider's phone position is used.
    const lat = num(req.query.lat), lng = num(req.query.lng);
    const det = await trash.createDetection({ uid: owner, deviceId, items: r.items, summary: r.summary, idea: r.idea || null, photo: preview,
      lat: Number.isFinite(lat) && Number.isFinite(lng) ? lat : null, lng: Number.isFinite(lat) && Number.isFinite(lng) ? lng : null });
    res.json({ paired: true, trash: true, id: det.id, summary: r.summary, known: det.litterNo });
  });

  // ---------------------------------------------------------------- detections from a smart camera (no images)
  //
  // A Raspberry Pi runs its own detector and sends only what it found, never a picture:
  //   POST /api/cam/detection   Content-Type: application/json
  //   { "device": "cam-7f3a",
  //     "items": [{ "label": "bottle", "material": "plastic", "confidence": 0.82,
  //                 "description": "Clear plastic bottle, small, ahead on the left", "pickupSafe": true }],
  //     "summary": "optional alert text", "lat": 43.78, "lng": -79.19 }      (lat/lng optional)
  // An empty items list is a heartbeat: it keeps the camera "Live" in the app.
  app.post('/api/cam/detection', async (req, res) => {
    const token = process.env.INGEST_TOKEN;
    if (token && req.get('x-scootsense-token') !== token) throw bad('Bad token', 401);
    const b = req.body || {};
    const deviceId = String(b.device || req.query.device || req.get('x-device-id') || '').trim().toLowerCase().slice(0, 40);
    if (!/^[a-z0-9-]{3,40}$/.test(deviceId)) throw bad('Send "device": the camera ID, like cam-7f3a');
    if (!Array.isArray(b.items)) throw bad('Send "items": a list of what the camera detected (empty list = heartbeat)');

    const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const items = b.items.slice(0, 8).map((i) => {
      const label = text(i?.label ?? i?.name, 60).toLowerCase();
      const material = MATERIALS.includes(i?.material) ? i.material : 'mixed';
      const confidence = Number.isFinite(Number(i?.confidence)) ? Math.max(0, Math.min(1, Number(i.confidence))) : null;
      const risky = material === 'hazardous' || /needle|syringe|broken glass|shard|battery|chemical/.test(label);
      return { name: label, material, confidence, description: text(i?.description, 160) || null, pickupSafe: risky ? false : i?.pickupSafe !== false };
    }).filter((i) => i.name && (i.confidence === null || i.confidence >= 0.5));

    const summary = text(b.summary, 160)
      || items.map((i) => i.description || i.name).join('; ').replace(/^./, (c) => c.toUpperCase());
    const owner = await trash.touchDevice(deviceId, null, items.length ? `litter: ${summary}` : 'clear');
    if (!owner) return res.json({ paired: false, message: `Link camera "${deviceId}" in the ScootSense app: Litter camera tab, Link.` });
    if (!items.length) return res.json({ paired: true, trash: false });
    if ((await trash.pendingDetections(owner)).length) return res.json({ paired: true, skipped: 'waiting for the rider to answer' });

    // Only text goes to Gemini: the item names and materials, to suggest something to make.
    const safe = items.filter((i) => i.pickupSafe);
    const { idea } = safe.length ? await gemini.upcycleIdea({ items: safe, inventory: await users.getStash(owner) }) : { idea: null };
    const lat = num(b.lat), lng = num(b.lng);
    const pos = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : { lat: null, lng: null };
    const det = await trash.createDetection({ uid: owner, deviceId, items, summary, idea: idea || null, photo: null, ...pos });
    res.json({ paired: true, trash: true, id: det.id, summary, known: det.litterNo });
  });

  // ---------------------------------------------------------------- rider's phone

  /** Poll: reports the rider's position and returns pending alerts plus camera status. */
  app.get('/api/cam/events', async (req, res) => {
    const who = actor(req);
    if (!who) return res.json({ pending: [], devices: [] });
    const lat = num(req.query.lat), lng = num(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) await trash.setPresence(who, lat, lng);
    const [pending, devices] = await Promise.all([trash.pendingDetections(who), member(req) ? trash.listDevices(who) : []]);
    res.json({ pending, devices });
  });

  app.get('/api/cam/devices/:id/frame', async (req, res) => {
    res.json({ frame: await trash.lastFrame(needMember(req), req.params.id) });
  });
  app.post('/api/me/devices', async (req, res) => res.json({ deviceId: await trash.linkDevice(needMember(req), req.body.deviceId) }));
  app.delete('/api/me/devices/:id', async (req, res) => { await trash.unlinkDevice(needMember(req), req.params.id); res.json({ ok: true }); });

  /** Phone-camera scans and demos create the same kind of alert as the ESP32-CAM. */
  app.post('/api/detections', async (req, res) => {
    const who = needActor(req);
    const { items, summary, idea, photo, lat, lng } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw bad('items required');
    res.json(await trash.createDetection({ uid: who, items, summary, idea, photo, lat: num(lat), lng: num(lng) }));
  });

  /** Demo: pretend the ESP32-CAM just saw a random piece of litter. */
  app.post('/api/cam/simulate', async (req, res) => {
    const who = needActor(req);
    const lat = num(req.body?.lat), lng = num(req.body?.lng);
    if (Number.isFinite(lat)) await trash.setPresence(who, lat, lng);
    const item = gemini.DEMO_TRASH[Math.floor(Math.random() * gemini.DEMO_TRASH.length)];
    const { idea } = await gemini.upcycleIdea({ items: [item], inventory: member(req) ? await users.getStash(who) : [] });
    const summary = `${item.name[0].toUpperCase()}${item.name.slice(1)} on the path ahead`;
    res.json(await trash.createDetection({ uid: who, deviceId: 'demo-cam', items: [{ ...item, pickupSafe: true }], summary, idea }));
  });

  /** The rider's answer: pickup (trash list), map (litter pin) or dismiss. */
  app.post('/api/detections/:id', async (req, res) => {
    const who = needActor(req);
    const det = await trash.getDetection(who, req.params.id);
    if (!det) throw bad('Alert not found', 404);
    if (det.status !== 'pending') return res.json({ ok: true, already: det.status });
    const action = req.body.action;
    const uid = member(req);
    if (action === 'pickup') {
      if (det.litterNo) await trash.checkLitter(det.litterNo, 'picked', who);
      let saved = [];
      if (uid) {
        saved = await trash.addUserTrash(uid, det.items, det.photo, det.deviceId ? 'camera' : 'phone');
        const stash = await users.getStash(uid);
        for (const i of det.items) {
          const hit = stash.find((s) => s.name.toLowerCase() === i.name.toLowerCase());
          if (hit) hit.qty += 1; else stash.push({ name: i.name, material: i.material, qty: 1 });
        }
        await users.setStash(uid, stash);
        await users.recordActivity(uid, 'pickup', det.items.length, { detection: det.id });
        if (det.idea) await users.addProject(uid, det.idea, `Litter you picked up: ${det.items.map((i) => i.name).join(', ')}`);
      }
      await trash.finishDetection(det.id, 'picked');
      return res.json({ ok: true, action, trash: saved, savedToAccount: !!uid });
    }
    if (action === 'map') {
      let litter;
      if (det.litterNo) litter = await trash.checkLitter(det.litterNo, 'still', who); // already pinned: confirm it
      else {
        const lat = det.lat ?? num(req.body.lat), lng = det.lng ?? num(req.body.lng);
        litter = await trash.addLitter({ lat, lng, items: det.items, summary: det.summary, photo: det.photo, reporterId: who });
      }
      if (uid) await users.recordActivity(uid, 'litter_report', det.items.length, { litter: litter.no });
      await trash.finishDetection(det.id, 'mapped', litter.no);
      return res.json({ ok: true, action, litter: litterSummary(litter) });
    }
    if (action === 'dismiss') {
      await trash.finishDetection(det.id, 'dismissed');
      return res.json({ ok: true, action });
    }
    throw bad('action must be pickup, map or dismiss');
  });

  // ---------------------------------------------------------------- shared litter map

  app.get('/api/litter', async (_req, res) => {
    res.json((await trash.listLitter()).filter((l) => l.status === 'reported').map(litterSummary));
  });

  app.get('/api/litter/:no', async (req, res) => {
    const l = await trash.getLitter(req.params.no);
    if (!l) throw bad('Litter report not found', 404);
    res.json(l);
  });

  /** "Is it still there?" from a rider passing by (or from the map). */
  app.post('/api/litter/:no/check', async (req, res) => {
    const who = actor(req);
    const answer = req.body.answer;
    const l = await trash.checkLitter(req.params.no, answer, who);
    const uid = member(req);
    if (uid && answer === 'picked') {
      await trash.addUserTrash(uid, l.items, l.photo, 'map');
      await users.recordActivity(uid, 'pickup', Math.max(1, l.items.length), { litter: l.no });
    } else if (uid) {
      await users.recordActivity(uid, 'litter_check', 1, { litter: l.no, answer });
    }
    res.json(litterSummary(l));
  });

  app.post('/api/litter/:no/clear', async (req, res) => {
    res.json(litterSummary(await trash.checkLitter(req.params.no, 'picked', actor(req))));
  });

  // ---------------------------------------------------------------- trash list

  app.get('/api/me/trash', async (req, res) => res.json(await trash.listUserTrash(needMember(req))));
  app.delete('/api/me/trash/:id', async (req, res) => { await trash.deleteUserTrash(needMember(req), req.params.id); res.json({ ok: true }); });
}
