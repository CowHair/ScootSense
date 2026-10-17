import { sensor } from './sensor.js';
import { $, $$, api, toast, md, esc, ic, skeletonText, classColor, classLabel, scoreColor, fmtDur, tileLayer, DEFAULT_CENTER } from './ui.js';
import { setScooterFix, currentPosition } from './geo.js';
import { initHero, swapHeroPhoto, setAir, setSpeed, crack } from './immersive.js';
import { CLASSES, CLASS_INFO, PM_BANDS, pmBand, POLLUTION_THRESHOLD } from '/shared/signal.js';

const SOURCE_TEXT = { sim: 'Start ride', serial: 'Connect and ride', wifi: 'Start ride' };
const SOURCE_NAME = { sim: 'Demo sensor', serial: 'USB sensor', wifi: 'Wi-Fi sensor' };
const AIR_SHORT = ['good', 'OK', 'poor', 'bad', 'very bad'];
// The Ride header shows a photo of the surface you're on. A bump or crack stays up for a
// couple of seconds so it doesn't vanish after a single half-second reading.
const ROAD_PHOTO = { smooth: 'road-smooth', joint: 'road-crack', rough: 'road-rough', bump: 'road-pothole' };
Object.values(ROAD_PHOTO).forEach((n) => { new Image().src = `/img/${n}.webp`; });
let held = 'smooth', holdUntil = 0, shownPhoto = 'land-home';

function heroLabel(label) {
  if (label !== 'smooth') { held = label; holdUntil = Date.now() + 2500; return label; }
  return Date.now() < holdUntil ? held : 'smooth';
}

function setRoadPhoto(label) {
  const pill = $('#road-pill');
  pill.querySelector('i').style.background = label ? classColor(label) : '#fff';
  pill.querySelector('span').textContent = label ? classLabel(label) : 'Ready';
  const name = label ? ROAD_PHOTO[label] : 'land-home'; // idle: the landscape
  if (name === shownPhoto) return;
  shownPhoto = name;
  swapHeroPhoto(`/img/${name}.webp`);
  if (label === 'bump') crack();
}

const ROAD_SAYS = { smooth: 'Nice and smooth.', joint: 'A small crack or seam.', rough: 'Bumpy surface here.', bump: 'Pothole or big bump! Saved to the map.' };
let selected = 'sim';
let chart, map, trackLayer, headMarker;
let ride = null;
let lastWindow = null;
let flushTimer = null, clockTimer = null, chartDirty = false;
let lastSmogAlert = 0;
const wave = [];
const WAVE_N = 400;

export function initLive() {
  buildChart();
  initHero();
  map = L.map('live-map', { zoomControl: false, attributionControl: false, preferCanvas: true }).setView(DEFAULT_CENTER, 16);
  tileLayer().addTo(map);
  trackLayer = L.layerGroup().addTo(map);

  $$('#source-seg button').forEach((b) => b.addEventListener('click', () => {
    if (sensor.running) return toast('Stop the current ride first.');
    selected = b.dataset.source;
    $$('#source-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateState();
  }));
  // The route map lives in a collapsed section; Leaflet must re-measure when it opens.
  $('#ride-details').addEventListener('toggle', () => setTimeout(() => map.invalidateSize(), 50));
  $('#btn-connect').addEventListener('click', () => (sensor.running ? stop() : start()));
  $$('[data-inject]').forEach((b) => b.addEventListener('click', () => {
    if (!sensor.running) return toast('Start the demo ride first.');
    sensor.inject(b.dataset.inject);
  }));
  $('#sim-speed').addEventListener('change', (e) => (sensor.simSpeed = Number(e.target.value)));
  sensor.simSpeed = Number($('#sim-speed').value);
  $('#btn-opinion').addEventListener('click', secondOpinion);

  renderProbs({});

  sensor.addEventListener('samples', (e) => {
    for (const s of e.detail.samples) wave.push(Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az));
    if (wave.length > WAVE_N) wave.splice(0, wave.length - WAVE_N);
    chartDirty = true;
  });
  sensor.addEventListener('window', (e) => onWindow(e.detail));
  sensor.addEventListener('hazards', (e) => logHazards(e.detail.hazards));
  sensor.addEventListener('ride', (e) => { if (ride) ride.id = e.detail.id; toast(`Wi-Fi sensor started ${e.detail.name}`, 'ok'); });
  sensor.addEventListener('error', (e) => toast(e.detail.message, 'err'));
  sensor.addEventListener('state', updateState);

  const draw = () => {
    if (chartDirty && !document.hidden && $('[data-view=ride]').classList.contains('active')) {
      chart.data.labels = wave.map((_, i) => i);
      chart.data.datasets[0].data = wave;
      chart.update('none');
      chartDirty = false;
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  loadAreaAir();
}

export function onShowLive() { map.invalidateSize(); }

function buildChart() {
  chart = new Chart($('#wave-chart'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#009688', borderWidth: 1.5, pointRadius: 0, tension: 0.15, fill: false }] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { suggestedMin: 0, suggestedMax: 2, ticks: { maxTicksLimit: 4 } } },
    },
  });
}

async function start() {
  try {
    $('#ride-summary').classList.add('hidden');
    trackLayer.clearLayers();
    const record = $('#record-ride').checked;
    ride = { id: null, startedAt: Date.now(), buffer: [], windows: 0, hazardHits: 0, scoreSum: 0, distM: 0, lastT: null, record, pmSum: 0, pmN: 0 };
    await sensor.start(selected);
    if (record && !sensor.serverSide) {
      const r = await api('/api/rides', { method: 'POST', body: { source: selected } });
      ride.id = r.id;
    }
    $('#event-log').innerHTML = '';
    flushTimer = setInterval(flush, 2000);
    clockTimer = setInterval(() => ($('#k-time').textContent = fmtDur(Date.now() - ride.startedAt)), 500);
    if (selected === 'wifi') toast('Listening… power on the ESP32 in Wi-Fi mode.', 'ok');
  } catch (e) {
    sensor.stop();
    ride = null;
    if (e.name !== 'NotFoundError') toast(e.message, 'err'); // NotFoundError = port picker closed
  }
}

async function stop() {
  sensor.stop();
  clearInterval(flushTimer); clearInterval(clockTimer);
  if (!ride) return;
  const r = ride;
  await flush();
  if (r.id && r.record) {
    await api(`/api/rides/${r.id}`, { method: 'PATCH', body: { end: true } }).catch(() => {});
    if (r.windows > 4) summarize(r.id);
  }
  window.dispatchEvent(new Event('data-changed'));
}

async function summarize(rideId) {
  const box = $('#ride-summary');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="card-title">Ride summary</div><div class="card-body">${skeletonText(4)}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const s = await api(`/api/ai/ride-summary/${rideId}`, { method: 'POST' });
    box.innerHTML = `<div class="card-title">Ride summary <span class="caption">${s.source === 'gemini' ? 'Gemini' : 'Offline'}</span></div>
      <div class="card-body markdown">${md(s.text)}</div>
      <div class="card-actions"><a class="btn flat" href="#map">View on map</a></div>`;
  } catch (e) {
    box.innerHTML = `<div class="card-body secondary">Could not summarise: ${esc(e.message)}</div>`;
  }
}

async function flush() {
  if (!ride?.id || !ride.buffer.length || sensor.serverSide) return;
  const batch = ride.buffer.splice(0);
  try {
    const out = await api(`/api/rides/${ride.id}/observations`, { method: 'POST', body: { observations: batch } });
    logHazards(out.hazards);
  } catch (e) {
    ride.buffer.unshift(...batch);
    toast('Upload failed, will retry: ' + e.message, 'err');
  }
}

function onWindow(w) {
  const { pred, features } = w;
  const shown = heroLabel(pred.label);
  $('#now-label').textContent = classLabel(shown);
  setRoadPhoto(shown);
  $('#now-conf').textContent = ROAD_SAYS[shown];
  $('#model-tag').textContent = pred.model === 'gnb' ? 'Trained model' : 'Rule-based model';
  $('#rate-label').textContent = `${features.fs} Hz`;
  renderProbs(pred.probs || { [pred.label]: pred.confidence });
  $('#now-reasons').innerHTML = (pred.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  if (w.mags.length && (pred.label !== 'smooth' || !lastWindow || lastWindow.pred.label === 'smooth')) lastWindow = w;
  $('#btn-opinion').disabled = !lastWindow;
  if (Number.isFinite(w.speed)) $('#chip-speed').textContent = `${Math.round(w.speed)} km/h`;
  $('#chip-gps').textContent = w.lat ? 'GPS fix' : 'No GPS';
  setScooterFix(w.lat, w.lng);
  if (Number.isFinite(w.pm25)) onAir(w.pm25);
  setSpeed(w.speed);

  if (!ride) return;
  ride.windows++;
  ride.scoreSum += features.score;
  if (Number.isFinite(w.pm25)) { ride.pmSum += w.pm25; ride.pmN++; }
  if (ride.lastT !== null && Number.isFinite(w.speed) && w.t > ride.lastT) ride.distM += (w.speed / 3.6) * ((w.t - ride.lastT) / 1000);
  ride.lastT = w.t;
  if (CLASS_INFO[pred.label].hazard) {
    ride.hazardHits++;
    logEvent(pred.label, classLabel(pred.label), w.lat ? 'Mapped at your location' : 'No GPS fix', pred.label === 'bump' ? 'warning' : 'texture');
  }
  if (ride.record && !sensor.serverSide) {
    ride.buffer.push({ t: w.t, at: new Date().toISOString(), lat: w.lat, lng: w.lng, speed: w.speed, pm25: w.pm25, features, ...pred });
  }
  $('#k-win').textContent = ride.windows;
  $('#k-haz').textContent = ride.hazardHits;
  $('#k-rough').textContent = Math.round(ride.scoreSum / ride.windows);
  $('#k-dist').textContent = (ride.distM / 1000).toFixed(2);
  $('#k-pm').textContent = ride.pmN ? Math.round(ride.pmSum / ride.pmN) : '—';

  if (Number.isFinite(w.lat)) {
    const ll = [w.lat, w.lng];
    L.circleMarker(ll, { radius: CLASS_INFO[pred.label].hazard ? 6 : 3.5, stroke: false, fillOpacity: 0.9, fillColor: scoreColor(features.score * 1.6) }).addTo(trackLayer);
    if (!headMarker) headMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: '#4285F4', fillOpacity: 1 }).addTo(map);
    headMarker.setLatLng(ll).bringToFront();
    if (!map.getBounds().pad(-0.2).contains(ll)) map.panTo(ll);
  }
}

function onAir(pm) {
  const band = pmBand(pm);
  setAir(pm);
  $('#air-big').textContent = Math.round(pm);
  $('#air-big').style.color = band.color;
  $('#air-band').textContent = band.label;
  $('#air-band').style.color = band.color;
  const word = AIR_SHORT[PM_BANDS.indexOf(band)] ?? '';
  $('#chip-air').textContent = word.charAt(0).toUpperCase() + word.slice(1);
  $('#chip-air').style.color = band.color;
  if (pm >= POLLUTION_THRESHOLD && Date.now() - lastSmogAlert > 30000) {
    lastSmogAlert = Date.now();
    logEvent('smog', 'Air pollution', `PM2.5 ${Math.round(pm)} µg/m³, ${band.label.toLowerCase()}`, 'cloud', band.color);
    toast(`Poor air quality: PM2.5 ${Math.round(pm)} µg/m³. Added to the map.`);
    try { navigator.userActivation?.hasBeenActive && navigator.vibrate?.(60); } catch {}
  }
}

/** Regional context from Open-Meteo (free, no key) to compare with street-level readings. */
async function loadAreaAir() {
  try {
    const p = currentPosition();
    const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat.toFixed(3)}&longitude=${p.lng.toFixed(3)}&current=pm2_5,us_aqi`).then((x) => x.json());
    if (r.current) $('#area-aq').textContent = `Area AQI ${r.current.us_aqi}`;
  } catch {}
}

function renderProbs(probs) {
  $('#prob-bars').innerHTML = CLASSES.map((c) => {
    const p = probs[c] || 0;
    return `<div class="prob"><span>${classLabel(c)}</span><div class="bar"><i style="width:${(p * 100).toFixed(0)}%;background:${classColor(c)}"></i></div><span>${(p * 100).toFixed(0)}%</span></div>`;
  }).join('');
}

const timeNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function logEvent(label, title, sub, icon, color) {
  const log = $('#event-log');
  log.querySelector('.empty')?.remove();
  const top = log.firstElementChild;
  if (top?.dataset.label === label) {
    const n = Number(top.dataset.n) + 1;
    top.dataset.n = n;
    top.querySelector('b').textContent = `${title} (${n})`;
    top.querySelector('.meta').textContent = timeNow();
    return;
  }
  const li = document.createElement('li');
  li.dataset.label = label;
  li.dataset.n = 1;
  li.innerHTML = `<span class="avatar" style="background:${color || classColor(label)}">${ic(icon)}</span>
    <div class="lines"><b>${esc(title)}</b><span>${esc(sub)}</span></div><span class="meta">${timeNow()}</span>`;
  log.prepend(li);
  while (log.children.length > 40) log.lastChild.remove();
}

const announced = new Map();
function logHazards(hazards) {
  for (const h of hazards || []) {
    if (announced.get(h.id) === h.reports) continue;
    announced.set(h.id, h.reports);
    const li = document.createElement('li');
    li.innerHTML = `<span class="avatar" style="background:#607D8B">${ic('place')}</span>
      <div class="lines"><b>${h.reports > 1 ? `Known hazard <a class="hz-link" data-hz="${h.no}">H${h.no}</a>` : `New hazard <a class="hz-link" data-hz="${h.no}">H${h.no}</a>`}</b>
      <span>${h.reports > 1 ? `Now detected on ${h.reports} rides` : 'Added to the community map'}</span></div><span class="meta">${timeNow()}</span>`;
    $('#event-log').querySelector('.empty')?.remove();
    $('#event-log').prepend(li);
  }
}

async function secondOpinion() {
  if (!lastWindow) return;
  const box = $('#opinion');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="loading"><span class="spinner"></span> Asking Gemini…</div>';
  try {
    const w = lastWindow;
    const o = await api('/api/ai/second-opinion', { method: 'POST', body: { features: w.features, waveform: w.mags, prediction: w.pred } });
    box.innerHTML = `<b>Gemini: ${classLabel(o.label)}</b> (${Math.round(o.confidence * 100)}%, ${o.agreesWithModel ? 'agrees' : 'disagrees'})<br>${esc(o.explanation)}`;
  } catch (e) {
    box.textContent = e.message;
  }
}

function updateState() {
  const k = sensor.kind;
  $('#btn-connect .sp-label').textContent = k ? 'Stop ride' : SOURCE_TEXT[selected];
  $('#btn-connect .sp-icon i').textContent = k ? 'stop' : 'play_arrow';
  $('#btn-connect').classList.toggle('stop', !!k);
  $('#btn-connect').classList.toggle('accent', !k);
  $('#ride-status').textContent = k ? (ride?.record ? 'Riding · sharing to the map' : 'Riding') : SOURCE_NAME[selected];
  $('#ride-status').className = `status-text ${k ? 'live' : ''}`;
  // Demo buttons only make sense during a demo ride.
  $('#sim-controls').classList.toggle('hidden', k !== 'sim');
  if (!k) {
    setSpeed(0);
    $('#now-label').textContent = 'Ready to ride';
    setRoadPhoto(null);
    $('#now-conf').textContent = 'Check the road, the air and litter as you go.';
  }
  const pill = $('#source-pill');
  pill.innerHTML = ic(k ? 'settings_input_antenna' : 'portable_wifi_off');
  pill.title = k ? `${{ sim: 'Demo', serial: 'USB', wifi: 'Wi-Fi' }[k]} sensor streaming` : 'No sensor connected';
  pill.classList.toggle('on', !!k);
  if (!k) { headMarker?.remove(); headMarker = null; }
}
