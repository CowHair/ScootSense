// The scooter camera, live on the Ride page while a ride is on.
//
// Asking for the picture every second also tells the server someone is watching, so the
// Raspberry Pi sends preview frames (with green boxes around any litter it sees) only then.
import { $, api } from './ui.js';
import { sensor } from './sensor.js';

const EVERY_MS = 1000;
let device = null;
let timer = null;
let since = '';
let lastFrameAt = 0;

export function initRideCam() {
  sensor.addEventListener('pi-status', (e) => {
    const d = e.detail?.device || null;
    if (d !== device) { device = d; since = ''; }
    sync();
  });
  sensor.addEventListener('state', sync);
  document.addEventListener('visibilitychange', sync);
}

function sync() {
  const on = sensor.running && sensor.kind === 'pi' && device && !document.hidden;
  $('#ride-live').classList.toggle('hidden', !(sensor.running && sensor.kind === 'pi'));
  if (on && !timer) {
    show('wait', 'Connecting to the scooter camera…');
    timer = setInterval(tick, EVERY_MS);
    tick();
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
  if (sensor.running && sensor.kind === 'pi' && !device) show('off', 'Link your scooter camera to see it here (Scan tab).');
}

function show(state, text) {
  const card = $('#ride-live');
  card.dataset.state = state;
  $('#rl-badge b').textContent = state === 'live' ? 'LIVE' : state === 'wait' ? 'WAITING' : 'OFF';
  if (text) $('#rl-status').textContent = text;
}

async function tick() {
  if (!device) return;
  let r;
  try {
    r = await api(`/api/cam/devices/${encodeURIComponent(device)}/live?since=${encodeURIComponent(since)}`);
  } catch {
    return show('wait', 'Reconnecting…');
  }
  if (r.frame) {
    $('#rl-img').src = r.frame;
    $('#rl-img').classList.remove('hidden');
    $('#rl-empty').classList.add('hidden');
    lastFrameAt = Date.now();
  }
  since = r.at || since;
  if (r.live) show('live', 'Live from your scooter. Green boxes show litter the camera has spotted.');
  else if (Date.now() - lastFrameAt > 8000) {
    show('wait', 'Waiting for pictures. The camera starts sending within a few seconds of opening this page.');
  }
}
