import { sql, backend, recordActivity } from './userdb.js';
import { requireUser } from './auth.js';
import { spotsTable } from './database-config.js';
import * as store from './store.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export async function collectSpot(id, uid) {
  if (!/^[1-9]\d*$/.test(String(id))) throw bad('Invalid map item');
  if (backend() !== 'tiger') {
    const db = store.getDb();
    const i = (db.spots || []).findIndex((s) => String(s.id) === String(id));
    if (i < 0) throw bad('This location was already removed. Refresh the map.', 409);
    db.spots.splice(i, 1);
    store.save();
  } else {
    const { rowCount } = await sql(`DELETE FROM ${spotsTable} WHERE id = $1`, [id]);
    if (!rowCount) throw bad('This location was already removed. Refresh the map.', 409);
  }
  await recordActivity(uid, 'pickup', 1, { source: 'spot', item_id: String(id) });
  return { ok: true, kind: 'spot', id: String(id), itemsCollected: 1 };
}

export function mountMapCompletions(app) {
  const sameOrigin = (req, _res, next) => {
    try {
      if (req.get('origin') && new URL(req.get('origin')).host !== req.get('host')) throw bad('Invalid request origin', 403);
      next();
    } catch (e) { next(e); }
  };
  app.post('/api/spots/:id/collect', requireUser, sameOrigin, async (req, res) => {
    req.mapCompletion = true;
    res.json(await collectSpot(req.params.id, req.session.uid));
  });
}
