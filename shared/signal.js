// Signal processing shared by the browser (live rides) and the server (Wi-Fi ingest, seeding).
// Pure ES module: no DOM, no Node APIs.

export const CLASSES = ['smooth', 'joint', 'rough', 'bump'];

export const CLASS_INFO = {
  smooth: { label: 'Smooth', color: '#4CAF50', hazard: false },
  joint:  { label: 'Crack / joint', color: '#FFB300', hazard: false },
  rough:  { label: 'Rough surface', color: '#FF9800', hazard: true },
  bump:   { label: 'Pothole / bump', color: '#F44336', hazard: true },
};

export const WINDOW_MS = 500;

/**
 * Parse one CSV line from the ESP32.
 * Supports the starter sketch (6 fields: t,ax,ay,az,lat,lng) and the full
 * ScootSense firmware (11-12 fields: t,ax,ay,az,gx,gy,gz,lat,lng,speed_kmh,sats[,pm25]).
 * pm25 is PM2.5 in µg/m³ from an optional PMS5003 air sensor.
 */
export function parseLine(line) {
  const s = line.trim();
  if (!/^\d/.test(s)) return null; // header or debug text
  const p = s.split(',');
  const num = (v) => (v === undefined || v === '' ? null : Number(v));
  if (p.length >= 11) {
    const o = {
      t: num(p[0]), ax: num(p[1]), ay: num(p[2]), az: num(p[3]),
      gx: num(p[4]), gy: num(p[5]), gz: num(p[6]),
      lat: num(p[7]), lng: num(p[8]), speed: num(p[9]), sats: num(p[10]), pm25: num(p[11]),
    };
    return valid(o) ? o : null;
  }
  if (p.length >= 4) {
    const o = { t: num(p[0]), ax: num(p[1]), ay: num(p[2]), az: num(p[3]),
      gx: null, gy: null, gz: null, lat: num(p[4]), lng: num(p[5]), speed: null, sats: null, pm25: null };
    return valid(o) ? o : null;
  }
  return null;
}

function valid(o) {
  return [o.t, o.ax, o.ay, o.az].every(Number.isFinite);
}

/** Compact array form used on the wire for Wi-Fi ingest. */
export function sampleFromArray(a) {
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  return { t: n(a[0]), ax: n(a[1]), ay: n(a[2]), az: n(a[3]), gx: n(a[4]), gy: n(a[5]), gz: n(a[6]),
    lat: n(a[7]), lng: n(a[8]), speed: n(a[9]), sats: n(a[10]), pm25: n(a[11]) };
}

/** Groups a stream of samples into fixed-duration windows. */
export class Windower {
  constructor(windowMs = WINDOW_MS) {
    this.windowMs = windowMs;
    this.buf = [];
    this.lastFix = null;
  }
  push(s) {
    if (Number.isFinite(s.lat) && Number.isFinite(s.lng) && !(s.lat === 0 && s.lng === 0)) {
      this.lastFix = { lat: s.lat, lng: s.lng, speed: s.speed };
    }
    // Device reboot / clock reset: start over.
    if (this.buf.length && s.t < this.buf[this.buf.length - 1].t) this.buf = [];
    this.buf.push(s);
    if (s.t - this.buf[0].t >= this.windowMs && this.buf.length >= 8) {
      const samples = this.buf;
      this.buf = [];
      const fix = this.lastFix;
      return {
        t0: samples[0].t, t1: samples[samples.length - 1].t, samples,
        lat: fix?.lat ?? null, lng: fix?.lng ?? null,
        speed: Number.isFinite(s.speed) ? s.speed : fix?.speed ?? null,
        pm25: meanOf(samples.map((x) => x.pm25)),
      };
    }
    return null;
  }
}

/** Vibration features for one window. Acceleration is in g. */
export function extractFeatures(samples) {
  const n = samples.length;
  const mag = samples.map((s) => Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az));
  const durS = Math.max((samples[n - 1].t - samples[0].t) / 1000, 1e-3);
  const fs = (n - 1) / durS;
  const mean = avg(mag);
  const dev = mag.map((m) => m - mean);
  const variance = avg(dev.map((d) => d * d));
  const std = Math.sqrt(variance);
  const maxDev = Math.max(...dev.map(Math.abs));
  const p2p = Math.max(...mag) - Math.min(...mag);
  let jerkSum = 0;
  for (let i = 1; i < n; i++) jerkSum += Math.abs(mag[i] - mag[i - 1]);
  const jerk = (jerkSum / (n - 1)) * fs; // g/s
  const kurtosis = variance > 1e-9 ? avg(dev.map((d) => d ** 4)) / (variance * variance) : 3;

  // Naive DFT is fine for ~25-50 samples.
  let best = 0, bestF = 0, hi = 0, total = 0;
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n;
      re += dev[i] * Math.cos(a);
      im -= dev[i] * Math.sin(a);
    }
    const p = re * re + im * im;
    const f = (k * fs) / n;
    total += p;
    if (f >= 8) hi += p;
    if (p > best) { best = p; bestF = f; }
  }
  const hfRatio = total > 0 ? hi / total : 0;

  const gyro = samples.filter((s) => Number.isFinite(s.gx));
  let gyroStd = null;
  if (gyro.length > 2) {
    const gm = gyro.map((s) => Math.sqrt(s.gx ** 2 + s.gy ** 2 + s.gz ** 2));
    const gmean = avg(gm);
    gyroStd = Math.sqrt(avg(gm.map((g) => (g - gmean) ** 2)));
  }

  return {
    n, fs: round(fs, 1), mean: round(mean, 4), std: round(std, 4), maxDev: round(maxDev, 4),
    p2p: round(p2p, 4), jerk: round(jerk, 3), kurtosis: round(kurtosis, 3),
    domFreq: round(bestF, 2), hfRatio: round(hfRatio, 3),
    gyroStd: gyroStd === null ? null : round(gyroStd, 3),
    score: roughnessScore(std, maxDev),
  };
}

/** 0-100 ride-roughness score blending sustained vibration and peak impact. */
export function roughnessScore(std, maxDev) {
  const sustained = 1 - Math.exp(-std / 0.2);
  const impact = 1 - Math.exp(-maxDev / 1.2);
  return Math.round(100 * (0.5 * sustained + 0.5 * impact));
}

export function haversine(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function meanOf(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? round(avg(v), 1) : null;
}

/** US EPA PM2.5 (24 h) breakpoints, used as a rough street-level guide. */
export const PM_BANDS = [
  { max: 12, label: 'Good', color: '#4CAF50' },
  { max: 35.4, label: 'Moderate', color: '#FFB300' },
  { max: 55.4, label: 'Unhealthy for sensitive groups', color: '#FF9800' },
  { max: 150.4, label: 'Unhealthy', color: '#F44336' },
  { max: Infinity, label: 'Very unhealthy', color: '#9C27B0' },
];
export const pmBand = (pm) => PM_BANDS.find((b) => pm <= b.max);
export const POLLUTION_THRESHOLD = 35.5;

/** A jolt this far from steady riding (in g) is a pothole, for the ESP32 sensor. */
export const POTHOLE_G = 0.8;

/** Grove Air Quality v1.3 levels (a gas sensor: no µg/m³). "high" and "severe" count as bad air. */
export const AIR_LEVEL_INFO = {
  fresh:  { label: 'Fresh air', color: '#4CAF50', bad: false },
  low:    { label: 'Some pollution', color: '#FFB300', bad: false },
  high:   { label: 'Polluted', color: '#FF7043', bad: true },
  severe: { label: 'Very polluted', color: '#E53935', bad: true },
};

/** Colour, title and band for an air hotspot, whether it came from PM2.5 or the gas sensor. */
export function airSpotLook(p) {
  if (Number.isFinite(p.pm25)) {
    const b = pmBand(p.pm25);
    return { color: b.color, title: `${Math.round(p.pm25)} µg/m³ PM2.5`, short: `Smog · ${Math.round(p.pm25)}`, band: b.label };
  }
  const a = AIR_LEVEL_INFO[p.airLevel] || AIR_LEVEL_INFO.high;
  return { color: a.color, title: `${a.label} (gas sensor)`, short: a.label, band: `Gas reading ${p.gas ?? '--'} of 1023` };
}

export function avg(a) { return a.reduce((s, v) => s + v, 0) / (a.length || 1); }
export function round(v, d = 3) { const m = 10 ** d; return Math.round(v * m) / m; }
