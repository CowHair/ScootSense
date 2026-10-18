import { sql, backend, transaction } from './userdb.js';
import * as store from './store.js';

const RADIUS = 5;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function parse(body) {
  const coord = body?.coord;
  if (!Array.isArray(coord) || coord.length !== 3 || !coord.every(Number.isInteger)) throw bad('coord must be three whole numbers');
  const type = body.type == null ? null : String(body.type).slice(0, 40);
  return { coord, type };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export async function addSpot(body) {
  const { coord, type } = parse(body);
  if (backend() !== 'tiger') {
    const db = store.getDb();
    db.spots ??= [];
    const near = db.spots.filter((s) => dist(s.coord, coord) <= RADIUS).sort((a, b) => dist(a.coord, coord) - dist(b.coord, coord))[0];
    if (near) { near.count += 1; near.lastSeen = new Date().toISOString(); store.save(); return { ...near, merged: true }; }
    const spot = { id: db.spots.length + 1, coord, type, count: 1, lastSeen: new Date().toISOString() };
    db.spots.push(spot);
    store.save();
    return { ...spot, merged: false };
  }
  return transaction(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(hashtext('city.spots'))`);
    const { rows } = await q(
      `UPDATE city.spots SET count = count + 1, last_seen = now()
       WHERE id = (SELECT id FROM city.spots
                   WHERE sqrt(power(coord[1] - $1, 2) + power(coord[2] - $2, 2) + power(coord[3] - $3, 2)) <= $4
                   ORDER BY power(coord[1] - $1, 2) + power(coord[2] - $2, 2) + power(coord[3] - $3, 2) LIMIT 1)
       RETURNING id, coord, type, count, last_seen`,
      [coord[0], coord[1], coord[2], RADIUS]);
    if (rows[0]) return { ...rows[0], merged: true };
    const ins = await q(`INSERT INTO city.spots (coord, type, count) VALUES ($1, $2, 1) RETURNING id, coord, type, count, last_seen`, [coord, type]);
    return { ...ins.rows[0], merged: false };
  });
}

export async function listSpots() {
  if (backend() !== 'tiger') return (store.getDb().spots || []).map(({ coord, type, count }) => ({ coord, type, count }));
  const { rows } = await sql(`SELECT coord, type, count FROM city.spots ORDER BY count DESC, id`);
  return rows;
}

export function mountSpots(app) {
  app.post('/api/spots', async (req, res) => res.json(await addSpot(req.body)));
  app.get('/api/spots', async (_req, res) => res.json(await listSpots()));
  app.get('/api/coords', async (_req, res) => res.json({ rows: (await listSpots()).map((s) => [s.coord, s.type, s.count]) }));
}
