// Physically-inspired scooter ride simulator. Produces the same sample format as the
// ESP32 firmware so the whole pipeline can be demoed (or tested) without hardware.
import { haversine } from './signal.js';

// A loop around the University of Toronto Scarborough campus (Hack the Valley).
export const DEMO_ROUTE = [
  [43.7871, -79.1939], [43.7870, -79.1905], [43.7866, -79.1873], [43.7858, -79.1847],
  [43.7843, -79.1829], [43.7826, -79.1838], [43.7812, -79.1859], [43.7808, -79.1889],
  [43.7815, -79.1918], [43.7830, -79.1936], [43.7851, -79.1944], [43.7871, -79.1939],
].map(([lat, lng]) => ({ lat, lng }));

// Ground-truth surface defects, positioned as a fraction of the loop length.
export const DEMO_DEFECTS = [
  { at: 0.06, type: 'bump', len: 2 },
  { at: 0.14, type: 'rough', len: 25 },
  { at: 0.22, type: 'bump', len: 2 },
  { at: 0.31, type: 'rough', len: 40 },
  { at: 0.40, type: 'bump', len: 2 },
  { at: 0.48, type: 'rough', len: 15 },
  { at: 0.57, type: 'bump', len: 2 },
  { at: 0.66, type: 'rough', len: 30 },
  { at: 0.745, type: 'bump', len: 2 },
  { at: 0.85, type: 'rough', len: 20 },
  { at: 0.92, type: 'bump', len: 2 },
];

// Street-level PM2.5 hotspots (µg/m³ above background), e.g. an idling bus stop and a construction site.
export const DEMO_POLLUTION = [
  { at: 0.18, peak: 42, spread: 70 },
  { at: 0.61, peak: 58, spread: 90 },
  { at: 0.88, peak: 30, spread: 50 },
];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPath(route) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + haversine(route[i - 1], route[i]));
  const total = cum[cum.length - 1];
  const pointAt = (d) => {
    d = ((d % total) + total) % total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { lat: route[i - 1].lat + f * (route[i].lat - route[i - 1].lat), lng: route[i - 1].lng + f * (route[i].lng - route[i - 1].lng) };
  };
  return { total, pointAt };
}

export function defectLocations(route = DEMO_ROUTE, defects = DEMO_DEFECTS) {
  const path = buildPath(route);
  return defects.map((d) => ({ ...d, ...path.pointAt(d.at * path.total) }));
}

/**
 * @param {object} o
 * @param {number} o.seed        RNG seed (different rides => different noise / swerves)
 * @param {number} o.fs          sample rate in Hz
 * @param {number} o.speedKmh    cruising speed
 * @param {number} o.laps        loops to ride before `done`
 * @param {number} o.swerveProb  chance the rider avoids a given bump on this ride
 */
export function createSimulator(o = {}) {
  const { seed = Date.now() % 1e9, fs = 50, speedKmh = 13, laps = 1, swerveProb = 0.2,
    route = DEMO_ROUTE, defects = DEMO_DEFECTS, startOffset = 0, background = true, pollution = DEMO_POLLUTION } = o;
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const path = buildPath(route);
  const dt = 1 / fs;
  const placed = defects.map((d) => ({ ...d, start: d.at * path.total - d.len / 2, end: d.at * path.total + d.len / 2,
    skip: d.type === 'bump' && rnd() < swerveProb }));

  let t = 0, dist = startOffset * path.total, nextJoint = dist + 35;
  let fix = null, lastFixT = -1;
  const impulses = []; // {t0, amp, freq, tau}
  let manualRoughUntil = -1;
  let manualSmogUntil = -1;
  let pm = 8;
  let prevDist = dist;

  const sim = {
    fs, total: path.total * laps, done: false,
    get progress() { return Math.min(1, (dist - startOffset * path.total) / (path.total * laps)); },
    get position() { return path.pointAt(dist); },
    /** Inject an event live during a demo. */
    trigger(type) {
      if (type === 'bump') addBump(1.4 + rnd() * 0.5);
      else if (type === 'joint') addJoint();
      else if (type === 'rough') manualRoughUntil = t + 2.5;
      else if (type === 'smog') manualSmogUntil = t + 30;
    },
    next() {
      const speed = Math.max(4, speedKmh + 2 * Math.sin(t / 9) + gauss() * 0.3); // km/h
      dist += (speed / 3.6) * dt;
      const lapPos = ((dist % path.total) + path.total) % path.total;
      const prevLapPos = ((prevDist % path.total) + path.total) % path.total;

      // Defects crossed in this step.
      let rough = t < manualRoughUntil;
      for (const d of placed) {
        if (d.type === 'rough' && lapPos >= d.start && lapPos <= d.end) rough = true;
        if (d.type === 'bump' && !d.skip && crossed(prevLapPos, lapPos, d.start)) {
          addBump(1.2 + rnd() * 0.8);
        }
      }
      if (background && dist >= nextJoint) {
        nextJoint += 30 + rnd() * 15;
        if (!placed.some((d) => lapPos > d.start - 3 && lapPos < d.end + 3)) addJoint();
      }
      // Occasional false positive: curb drop, debris, rider stepping on deck.
      if (background && rnd() < 0.0003) addBump(0.9 + rnd() * 0.4);

      // Vibration model (g).
      const speedFactor = Math.sqrt(speed / 13);
      let z = gauss() * 0.022 * speedFactor + 0.01 * Math.sin(2 * Math.PI * 1.8 * t);
      let x = gauss() * 0.015, y = gauss() * 0.015;
      if (rough) {
        const r = 0.12 + 0.05 * speedFactor;
        z += r * (0.6 * Math.sin(2 * Math.PI * 14 * t + rnd()) + 0.8 * gauss() * 0.7);
        x += gauss() * r * 0.35; y += gauss() * r * 0.35;
      }
      let gyroKick = 0;
      for (let i = impulses.length - 1; i >= 0; i--) {
        const p = impulses[i];
        const age = t - p.t0;
        if (age < 0) continue;
        if (age > p.tau * 6) { impulses.splice(i, 1); continue; }
        const v = p.amp * Math.exp(-age / p.tau) * Math.cos(2 * Math.PI * p.freq * age);
        z += v; x += v * 0.18; gyroKick += Math.abs(v) * 60;
      }
      // Gentle pitch/roll from the rider.
      const pitch = 0.04 * Math.sin(2 * Math.PI * 0.3 * t);
      const sample = {
        t: Math.round(t * 1000),
        ax: round3(x + pitch), ay: round3(y), az: round3(1 + z),
        gx: round2(gauss() * 2 + gyroKick), gy: round2(gauss() * 2), gz: round2(gauss() * 1.5),
        lat: null, lng: null, speed: round2(speed), sats: 9, pm25: null,
      };
      // PMS5003 reports ~1 Hz; model a slowly-responding sensor around background + hotspots.
      let target = 7 + 2 * Math.sin(t / 40) + (t < manualSmogUntil ? 70 : 0);
      for (const p of pollution) {
        const dd = Math.abs(lapPos - p.at * path.total);
        const d = Math.min(dd, path.total - dd);
        target += p.peak * Math.exp(-((d / p.spread) ** 2));
      }
      pm += (target - pm) * 0.02 + gauss() * 0.15;
      sample.pm25 = Math.round(Math.max(1, pm) * 10) / 10;
      // GPS updates at 1 Hz with ~2.5 m noise.
      if (Math.floor(t) !== lastFixT) {
        lastFixT = Math.floor(t);
        const p = path.pointAt(dist);
        fix = { lat: p.lat + gauss() * 2.2e-5, lng: p.lng + gauss() * 3e-5 };
      }
      sample.lat = +fix.lat.toFixed(6);
      sample.lng = +fix.lng.toFixed(6);

      prevDist = dist;
      t += dt;
      if (dist - startOffset * path.total >= path.total * laps) sim.done = true;
      return sample;
    },
  };

  function addBump(amp) {
    impulses.push({ t0: t, amp, freq: 11 + rnd() * 4, tau: 0.06 });
    // Rear wheel hits ~0.8 m later.
    impulses.push({ t0: t + 0.8 / (speedKmh / 3.6), amp: amp * 0.7, freq: 12, tau: 0.05 });
  }
  function addJoint() {
    impulses.push({ t0: t, amp: 0.38 + rnd() * 0.2, freq: 18, tau: 0.012 });
  }
  return sim;
}

function crossed(prev, cur, mark) {
  return prev <= cur ? prev < mark && cur >= mark : prev < mark || cur >= mark;
}
const round3 = (v) => Math.round(v * 1000) / 1000;
const round2 = (v) => Math.round(v * 100) / 100;

/** Labelled bench-test windows for quickly bootstrapping the classifier. */
export function syntheticTrainingSet({ perClass = 40, recordings = 4, seed = 7 } = {}) {
  const out = [];
  for (let r = 0; r < recordings; r++) {
    for (const label of ['smooth', 'joint', 'rough', 'bump']) {
      const sim = createSimulator({ seed: seed + r * 31 + label.length, defects: [], route: DEMO_ROUTE, background: false });
      const rid = `synthetic-${r}-${label}`;
      let made = 0, buf = [];
      while (made < perClass / recordings * 1.0 + 1) {
        if (buf.length === 0) {
          if (label === 'bump') sim.trigger('bump');
          if (label === 'joint') sim.trigger('joint');
          if (label === 'rough') sim.trigger('rough');
        }
        buf.push(sim.next());
        if (buf.length >= 25) {
          out.push({ label, recordingId: rid, samples: buf });
          buf = [];
          made++;
        }
      }
    }
  }
  return out;
}
