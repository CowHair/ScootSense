// Seeds realistic demo data by running the simulator through the real pipeline.
// `npm run seed` wipes the database and reseeds it.
import * as store from './store.js';
import { createSimulator } from '../shared/simulator.js';
import { Windower, extractFeatures } from '../shared/signal.js';
import { classify } from '../shared/classifier.js';

const RIDES = [
  { name: 'Campus loop — morning', speedKmh: 12, daysAgo: 9 },
  { name: 'Campus loop — after class', speedKmh: 14, daysAgo: 7 },
  { name: 'Military Trail commute', speedKmh: 13, daysAgo: 5 },
  { name: 'Evening loop', speedKmh: 11, daysAgo: 3 },
  { name: 'Hack the Valley warm-up', speedKmh: 15, daysAgo: 1 },
];

export function seedDemo() {
  RIDES.forEach((r, i) => {
    const ride = store.createRide({ name: r.name, source: 'demo' });
    const start = Date.now() - r.daysAgo * 86400000 - 3600000 * (2 + i);
    ride.startedAt = new Date(start).toISOString();
    const sim = createSimulator({ seed: 1000 + i * 77, speedKmh: r.speedKmh, startOffset: (i * 0.13) % 1 });
    const w = new Windower();
    const batch = [];
    while (!sim.done) {
      const win = w.push(sim.next());
      if (!win) continue;
      const features = extractFeatures(win.samples);
      batch.push({ t: win.t1, at: new Date(start + win.t1).toISOString(), lat: win.lat, lng: win.lng,
        speed: win.speed, pm25: win.pm25, features, ...classify(features, null) });
    }
    store.addObservations(ride.id, batch);
    ride.endedAt = new Date(start + batch.at(-1).t).toISOString();
  });

  // A little community verification so the dashboard tells a story.
  const ranked = store.listHazards();
  ranked.slice(0, 3).forEach((h) => { store.voteHazard(h.id, 'confirm'); store.voteHazard(h.id, 'confirm'); });
  const singleton = ranked.filter((h) => h.reports === 1).at(-1);
  if (singleton) store.voteHazard(singleton.id, 'dismiss');
  if (ranked[1]) store.rawHazard(ranked[1].id).notes.push({ at: new Date().toISOString(), text: 'Raised slab near the bus stop. Wheelchair users route onto the road here.' });
  // Litter riders chose to leave for a clean-up crew, and some they picked up themselves.
  const litter = [
    [43.78695, -79.19120, [{ name: 'plastic bottles', material: 'plastic' }, { name: 'chip bag', material: 'plastic' }], 'Bottles and snack wrappers by the bench'],
    [43.78315, -79.18365, [{ name: 'coffee cups', material: 'paper' }], 'Coffee cups next to the bus shelter'],
    [43.78105, -79.18750, [{ name: 'cardboard box', material: 'cardboard' }, { name: 'plastic bag', material: 'plastic' }], 'Flattened box and bag in the bike lane'],
    [43.78400, -79.19390, [{ name: 'glass bottle', material: 'glass' }], 'Glass bottle on the path (not safe to grab)'],
  ];
  litter.forEach(([lat, lng, items, summary]) => store.addLitter({ lat, lng, items, summary, status: 'reported' }));
  for (let i = 0; i < 6; i++) store.addLitter({ items: [{ material: i % 2 ? 'metal' : 'plastic' }], status: 'picked' });
  store.getDb().upcycleIdeas = 4;
  store.flush();
  const s = store.stats();
  console.log(`Seeded ${s.rides} rides, ${s.observations} observations, ${s.hazards} hazards (${s.distanceKm} km).`);
}

if (process.argv[1] && import.meta.filename === process.argv[1] && process.argv.includes('--reset')) {
  store.reset();
  seedDemo();
}
