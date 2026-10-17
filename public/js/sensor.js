import { Windower, extractFeatures, parseLine } from '/shared/signal.js';
import { classify } from '/shared/classifier.js';
import { createSimulator } from '/shared/simulator.js';

class Sensor extends EventTarget {
  kind = null;
  model = null;
  simSpeed = 3;
  #windower = new Windower();
  #stopFns = [];
  #sim = null;
  lastSamples = [];

  get running() { return this.kind !== null; }
  get serverSide() { return this.kind === 'wifi'; }

  async start(kind) {
    this.stop();
    this.#windower = new Windower();
    if (kind === 'sim') this.#startSim();
    else if (kind === 'serial') await this.#startSerial();
    else if (kind === 'wifi') this.#startWifi();
    this.kind = kind;
    this.#emit('state', { kind });
  }

  stop() {
    this.#stopFns.forEach((f) => f());
    this.#stopFns = [];
    const was = this.kind;
    this.kind = null;
    this.#sim = null;
    if (was) this.#emit('state', { kind: null });
  }

  inject(type) { this.#sim?.trigger(type); }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  #ingest(samples) {
    if (!samples.length) return;
    this.lastSamples = this.lastSamples.concat(samples).slice(-100);
    this.#emit('samples', { samples });
    if (this.serverSide) return;
    for (const s of samples) {
      const w = this.#windower.push(s);
      if (!w) continue;
      const features = extractFeatures(w.samples);
      const pred = classify(features, this.model);
      this.#emit('window', {
        t: w.t1, lat: w.lat, lng: w.lng, speed: w.speed, pm25: w.pm25, features, pred,
        mags: w.samples.map((x) => +Math.sqrt(x.ax * x.ax + x.ay * x.ay + x.az * x.az).toFixed(3)),
      });
    }
  }

  #startSim() {
    const sim = createSimulator({ laps: 50, seed: Math.floor(Math.random() * 1e6) });
    this.#sim = sim;
    let carry = 0;
    const tickMs = 50;
    const id = setInterval(() => {
      carry += (sim.fs * tickMs / 1000) * this.simSpeed;
      const n = Math.floor(carry);
      carry -= n;
      const out = [];
      for (let i = 0; i < n; i++) out.push(sim.next());
      this.#ingest(out);
    }, tickMs);
    this.#stopFns.push(() => clearInterval(id));
  }

  async #startSerial() {
    if (!('serial' in navigator)) throw new Error('Web Serial needs Chrome or Edge on desktop. Use the simulator or Wi-Fi mode instead.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    const decoder = new TextDecoderStream();
    const closed = port.readable.pipeTo(decoder.writable).catch(() => {});
    const reader = decoder.readable.getReader();
    let alive = true, buf = '';
    this.#stopFns.push(async () => {
      alive = false;
      try { await reader.cancel(); } catch {}
      await closed;
      try { await port.close(); } catch {}
    });
    (async () => {
      while (alive) {
        let r;
        try { r = await reader.read(); } catch { break; }
        if (r.done) break;
        buf += r.value;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        const out = [];
        for (const line of lines) {
          const s = parseLine(line);
          if (s) out.push(s);
          else if (line.includes('not found')) this.#emit('error', { message: line.trim() });
        }
        this.#ingest(out);
      }
      if (alive) { this.#emit('error', { message: 'Serial device disconnected' }); this.stop(); }
    })();
  }

  #startWifi() {
    const es = new EventSource('/api/live');
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'batch') {
        this.#ingest(msg.samples);
        for (const o of msg.observations) {
          this.#emit('window', { t: o.t, lat: o.lat, lng: o.lng, speed: o.speed, pm25: o.pm25, features: o.features,
            pred: { label: o.label, confidence: o.confidence, probs: o.probs, model: o.model, reasons: o.reasons },
            mags: [], rideId: msg.rideId });
        }
        if (msg.hazards?.length) this.#emit('hazards', { hazards: msg.hazards });
      } else if (msg.type === 'ride') {
        this.#emit('ride', msg.ride);
      }
    };
    this.#stopFns.push(() => es.close());
  }
}

export const sensor = new Sensor();
