import { chibiLitter } from './chibi.js';
import { $, api, toast, esc, ic } from './ui.js';
import { getStash, saveProject } from './stash.js';
import { currentPosition, watchPhone } from './geo.js';
import { isMember } from './auth.js';

let dialogOpen = false;
export const isDialogOpen = () => dialogOpen;

export function openDialog(html) {
  dialogOpen = true;
  $('#trash-backdrop').classList.remove('hidden');
  const dlg = $('#trash-sheet');
  dlg.classList.remove('hidden');
  dlg.innerHTML = html;
  return dlg;
}

export function closeDialog() {
  dialogOpen = false;
  $('#trash-sheet').classList.add('hidden');
  $('#trash-backdrop').classList.add('hidden');
}

export function buzz() {
  try { navigator.userActivation?.hasBeenActive && navigator.vibrate?.([90, 50, 90]); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.1, ctx.currentTime + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.14 + 0.13);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.14);
      o.stop(ctx.currentTime + i * 0.14 + 0.14);
    });
  } catch {}
}

export const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

export function realPosition() {
  const p = currentPosition();
  return /approximate/.test(p.source) ? null : p;
}

let pollTimer = null;
let device = null;
let shownFrameAt = null;
let handling = null;
let alerts = 0;

export function initScan() {
  $('#cam-link').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { deviceId } = await api('/api/me/devices', { method: 'POST', body: { deviceId: $('#cam-link-id').value } });
      $('#cam-link-id').value = '';
      toast(`Camera ${deviceId} linked. Power it on to start scanning.`, 'ok');
      poll();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#btn-cam-unlink').addEventListener('click', async () => {
    if (!device || !confirm(`Unlink camera ${device.deviceId}?`)) return;
    await api(`/api/me/devices/${device.deviceId}`, { method: 'DELETE' });
    device = null;
    renderDevice();
  });
  $('#btn-sim-cam').addEventListener('click', simulateDetection);
  $('#btn-sim-trash').addEventListener('click', simulateDetection);
  $('#trash-backdrop').addEventListener('click', () => { if (!handling) closeDialog(); });
  $('#cam-frame').addEventListener('error', () => {
    $('#cam-frame').classList.add('hidden');
    $('#cam-preview-empty').classList.remove('hidden');
  });
  initPhoneCamera();
}

export function startCameraPolling() {
  const member = isMember();
  $('#cam-link').classList.toggle('hidden', !member);
  $('#cam-help').classList.toggle('hidden', !member);
  $('#cam-guest').classList.toggle('hidden', member);
  watchPhone();
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, 4000);
}

async function poll() {
  const p = realPosition();
  const q = p ? `?lat=${p.lat.toFixed(6)}&lng=${p.lng.toFixed(6)}` : '';
  let r;
  try { r = await fetch(`/api/cam/events${q}`).then((x) => x.json()); } catch { return; }
  device = r.devices?.[0] || null;
  renderDevice();
  const next = (r.pending || [])[0];
  if (next && !dialogOpen && handling !== next.id) showDetection(next);
}

function renderDevice() {
  const linked = !!device;
  const online = linked && device.lastFrameAt && Date.now() - Date.parse(device.lastFrameAt) < 30_000;
  const state = $('#cam-state');
  state.className = `cam-state ${online ? 'online' : linked ? 'offline' : ''}`;
  state.querySelector('span').textContent = online ? 'Live' : linked ? 'Offline' : 'Not linked';
  if (!stream) $('#chip-scan').textContent = online ? 'Live' : linked ? 'Offline' : 'Not linked';
  $('#cam-linked').classList.toggle('hidden', !linked);
  $('#btn-cam-unlink').classList.toggle('hidden', !linked);
  if (isMember()) $('#cam-link').classList.toggle('hidden', linked);
  if (!linked) return;
  $('#cam-id').textContent = device.deviceId;
  $('#cam-last').textContent = device.lastFrameAt ? ` · last update ${ago(device.lastFrameAt)}` : ' · waiting for the camera';
  $('#cam-result').textContent = device.lastResult ? `Last check: ${device.lastResult}` : '';
  if (device.lastFrameAt && device.lastFrameAt !== shownFrameAt && $('[data-view=scan]').classList.contains('active')) {
    shownFrameAt = device.lastFrameAt;
    api(`/api/cam/devices/${device.deviceId}/frame`).then(({ frame }) => {
      if (!frame) return;
      $('#cam-frame').src = frame;
      $('#cam-frame').classList.remove('hidden');
      $('#cam-preview-empty').classList.add('hidden');
    }).catch(() => {});
  }
}

async function simulateDetection() {
  const p = realPosition() || currentPosition();
  openDialog(`<div class="dialog-body"><h2>Litter spotted</h2><div class="loading"><span class="spinner"></span> The camera is checking…</div></div>`);
  try {
    const det = await api('/api/cam/simulate', { method: 'POST', body: { lat: p.lat, lng: p.lng } });
    closeDialog();
    showDetection(det);
  } catch (e) {
    closeDialog();
    toast(e.message, 'err');
  }
}

function showDetection(det) {
  handling = det.id;
  buzz();
  chibiLitter();
  const unsafe = det.items.some((i) => i.pickupSafe === false);
  const known = det.litterNo;
  const dlg = openDialog(`
    ${det.photo ? `<img class="photo" src="${det.photo}" alt="Litter seen by the scooter camera" />` : ''}
    <div class="dialog-body">
      <h2 id="trash-title">Litter spotted</h2>
      <div>${esc(det.summary)}${known ? ` <span class="secondary">It's already on the map as L${known}.</span>` : ''}</div>
      <ul class="items">${det.items.map((i) => `<li class="${i.pickupSafe === false ? 'warn' : ''}">${esc(i.description || i.name)}${i.material && !String(i.description || '').toLowerCase().includes(i.material) ? ` (${esc(i.material)})` : ''}${i.confidence ? ` <span class="secondary small">${Math.round(i.confidence * 100)}% sure</span>` : ''}${i.pickupSafe === false ? ', do not touch' : ''}</li>`).join('')}</ul>
      <div class="notice">Pull over safely before choosing.${unsafe ? ' Some of this is unsafe to handle, so leave it for a clean-up crew.' : ''}</div>
      <div id="idea-box">${det.idea ? ideaHtml(det.idea) : unsafe ? '' : '<div class="idea"><div class="loading"><span class="spinner"></span> Finding something you could make with it…</div></div>'}</div>
      ${!isMember() ? '<div class="secondary small">Sign in to keep a trash list of what you pick up.</div>' : ''}
    </div>
    <div class="dialog-actions">
      <button class="btn flat left" data-act="dismiss">Not litter</button>
      <button class="btn flat" data-act="map">${known ? 'Still there' : 'Leave it'}</button>
      <button class="btn flat accent-text" data-act="pickup" ${unsafe ? 'disabled' : ''}>Pick it up</button>
    </div>`);
  let idea = det.idea;
  if (!idea && !unsafe) {
    api('/api/ai/upcycle', { method: 'POST', body: { items: det.items, inventory: getStash() } })
      .then((r) => { if (handling === det.id) { idea = r.idea; $('#idea-box').innerHTML = ideaHtml(r.idea); } })
      .catch(() => { $('#idea-box').innerHTML = ''; });
  }
  dlg.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => resolve(det, b.dataset.act, det.idea ? null : idea)));
}

function ideaHtml(idea) {
  const uses = [...(idea.usesFromHome || []), ...(idea.extraNeeded || []).map((x) => `${x} (extra)`)];
  return `<div class="idea">
    <div class="subheader" style="margin:0">Make something with it</div>
    <h3>${esc(idea.title)}</h3>
    <div class="secondary">${esc(idea.pitch)}</div>
    ${uses.length ? `<div class="uses">You'll need: ${uses.map(esc).join(', ')}</div>` : ''}
    <ol>${(idea.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <div class="secondary small">About ${idea.minutes || '?'} min. ${esc(idea.safety || '')}</div>
  </div>`;
}

async function resolve(det, action, clientIdea) {
  const p = realPosition() || currentPosition();
  $('#trash-sheet').querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
  try {
    const r = await api(`/api/detections/${det.id}`, { method: 'POST', body: { action, lat: p.lat, lng: p.lng } });
    closeDialog();
    if (action === 'pickup') {
      if (clientIdea && isMember()) await saveProject(clientIdea, `Litter you picked up: ${det.items.map((i) => i.name).join(', ')}`);
      toast(r.savedToAccount ? `Added to your trash list. Thanks for picking it up!` : 'Thanks for picking it up!', 'ok');
    } else if (action === 'map') {
      toast(det.litterNo ? `Thanks. L${det.litterNo} is marked as still there.` : `Left on the map as L${r.litter.no}. Other riders will be asked if it's still there.`, 'ok');
    } else {
      toast('Dismissed');
    }
    logAlert(det, action);
    window.dispatchEvent(new Event('data-changed'));
    window.dispatchEvent(new Event('trash-changed'));
  } catch (e) {
    toast(e.message, 'err');
    $('#trash-sheet').querySelectorAll('[data-act]').forEach((b) => (b.disabled = false));
  } finally {
    handling = null;
  }
}

const ACTION_LABEL = { pickup: ['Picked up', 'done', '#4CAF50'], map: ['Left on the map', 'place', '#9C27B0'], dismiss: ['Dismissed', 'close', '#9E9E9E'] };

function logAlert(det, action) {
  const ul = $('#scan-log');
  ul.querySelector('.empty')?.remove();
  const [label, icon, color] = ACTION_LABEL[action];
  const li = document.createElement('li');
  li.innerHTML = `${det.photo ? `<img class="avatar" src="${det.photo}" alt="" />` : `<span class="avatar" style="background:${color}">${ic(icon)}</span>`}
    <div class="lines"><b>${esc(det.summary || det.items.map((i) => i.name).join(', '))}</b><span>${label}${det.deviceId ? ` · ${esc(det.deviceId)}` : ''}</span></div>
    <span class="meta">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
  ul.prepend(li);
  while (ul.children.length > 15) ul.lastChild.remove();
  $('#scan-count').textContent = `${++alerts} this session`;
}

let stream = null;
let timer = null;
let busy = false;
let cooldownUntil = 0;
let warnedNoKey = false;

function initPhoneCamera() {
  $('#btn-cam').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
  $('#btn-snap').addEventListener('click', () => scanFrame(true));
  $('#scan-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) scanImage(await shrinkImage(f, 768), true);
    e.target.value = '';
  });
  $('#auto-scan').addEventListener('change', schedule);
  $('#scan-every').addEventListener('change', schedule);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('The camera needs HTTPS and a supported browser. Try Upload instead.', 'err');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    stream = null;
    return toast(e.name === 'NotAllowedError' ? 'Camera permission denied' : 'Could not open the camera', 'err');
  }
  $('#cam').srcObject = stream;
  await $('#cam').play().catch(() => {});
  $('#cam-empty').classList.add('hidden');
  $('#scan-badge').classList.remove('hidden');
  $('#btn-cam').textContent = 'Stop camera';
  $('#btn-cam').classList.replace('accent', 'stop');
  $('#btn-snap').disabled = false;
  setScanState(true);
  schedule();
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  clearInterval(timer);
  $('#cam').srcObject = null;
  $('#cam-empty').classList.remove('hidden');
  $('#scan-badge').classList.add('hidden');
  $('#btn-cam').textContent = 'Start camera';
  $('#btn-cam').classList.replace('stop', 'accent');
  $('#btn-snap').disabled = true;
  setScanState(false);
}

function setScanState(on) {
  $('#chip-scan').textContent = on ? 'Phone on' : 'Not linked';
}

function schedule() {
  clearInterval(timer);
  if (!stream || !$('#auto-scan').checked) { $('#scan-text').textContent = 'Paused'; return; }
  const every = Number($('#scan-every').value) * 1000;
  $('#scan-text').textContent = `Scanning every ${every / 1000} s`;
  timer = setInterval(() => scanFrame(false), every);
}

function grabFrame(maxW = 640) {
  const v = $('#cam');
  if (!v.videoWidth) return null;
  const k = Math.min(1, maxW / v.videoWidth);
  const c = $('#cam-canvas');
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

function scanFrame(manual) {
  if (!stream || busy || dialogOpen || document.hidden) return;
  if (!manual && Date.now() < cooldownUntil) return;
  const image = grabFrame();
  if (image) scanImage(image, manual);
}

async function scanImage(image, manual) {
  busy = true;
  $('#scan-text').textContent = 'Checking…';
  try {
    const r = await api('/api/ai/scan', { method: 'POST', body: { image, inventory: getStash() } });
    if (r.error) {
      if (!warnedNoKey || manual) toast(r.error, 'err');
      warnedNoKey = true;
      if (/not configured/.test(r.error)) { $('#auto-scan').checked = false; schedule(); }
      return;
    }
    if (r.trashDetected && r.items?.length && (r.confidence ?? 1) >= 0.5) {
      cooldownUntil = Date.now() + 15000;
      const p = realPosition() || currentPosition();
      const det = await api('/api/detections', { method: 'POST', body: {
        items: r.items, summary: r.summary, idea: r.idea || null, photo: await shrinkDataUrl(image, 480), lat: p.lat, lng: p.lng } });
      showDetection(det);
    } else if (manual) {
      toast(r.summary || 'No litter found');
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy = false;
    if (stream) schedule();
  }
}

export function shrinkImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(drawScaled(img, max)); };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

export function shrinkDataUrl(url, max) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(drawScaled(img, max));
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function drawScaled(img, max) {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

