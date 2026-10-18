// The scooter camera, live on the Ride page while a ride is on.
//
// Asking for the picture a few times a second also tells the server someone is watching, so the
// Raspberry Pi sends preview frames (with green boxes around any litter it sees) only then.
import { $, api } from './ui.js';
import { sensor } from './sensor.js';

const EVERY_MS = 250;   // the Pi sends up to four frames a second
let device = null;
let timer = null;
let polling = false;
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
  if (on && !polling) {
    show('wait', 'Connecting to the scooter camera…');
    polling = true;
    loop();
  } else if (!on && polling) {
    polling = false;
    clearTimeout(timer);
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

/** One request at a time: the next starts EVERY_MS after the last one began (or at once if it was slow). */
async function loop() {
  if (!polling) return;
  const started = Date.now();
  await tick();
  if (polling) timer = setTimeout(loop, Math.max(0, EVERY_MS - (Date.now() - started)));
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
