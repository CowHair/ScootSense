// Camera litter scanner. A phone on the handlebar sends one frame every few seconds to
// Gemini, which detects litter and, in the same call, suggests a project built from that
// litter plus the rider's home stash. The rider then picks it up or adds it to the map.
import { $, api, toast, esc, ic } from './ui.js';
import { getStash, saveProject } from './stash.js';
import { currentPosition, watchPhone } from './geo.js';

let stream = null;
let timer = null;
let busy = false;
let alertOpen = false;
let cooldownUntil = 0;
let scans = 0;
let warnedNoKey = false;

export function initScan() {
  $('#btn-cam').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
  $('#btn-snap').addEventListener('click', () => scanFrame(true));
  $('#scan-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) scanImage(await shrinkImage(f, 768), true);
    e.target.value = '';
  });
  $('#btn-demo-trash').addEventListener('click', simulateTrash);
  $('#btn-sim-trash').addEventListener('click', simulateTrash);
  $('#auto-scan').addEventListener('change', schedule);
  $('#scan-every').addEventListener('change', schedule);
  $('#trash-backdrop').addEventListener('click', closeAlert);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('The camera needs HTTPS and a supported browser. Try Upload instead.', 'err');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    stream = null;
    return toast(e.name === 'NotAllowedError' ? 'Camera permission denied' : 'Could not open the camera', 'err');
  }
  const v = $('#cam');
  v.srcObject = stream;
  await v.play().catch(() => {});
  watchPhone();
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
  $('.tab-scan').classList.toggle('scanning', on);
  $('#chip-scan').textContent = on ? 'Camera on' : 'Camera off';
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

async function scanFrame(manual) {
  if (!stream || busy || alertOpen || document.hidden) return;
  if (!manual && Date.now() < cooldownUntil) return;
  const image = grabFrame();
  if (image) scanImage(image, manual);
}

async function scanImage(image, manual) {
  busy = true;
  $('#scan-text').textContent = 'Checking…';
  try {
    const r = await api('/api/ai/scan', { method: 'POST', body: { image, inventory: getStash() } });
    scans++;
    $('#scan-count').textContent = `${scans} checked`;
    if (r.error) {
      if (!warnedNoKey || manual) toast(r.error, 'err');
      warnedNoKey = true;
      if (/not configured/.test(r.error)) { $('#auto-scan').checked = false; schedule(); }
      return;
    }
    logScan(image, r);
    if (r.trashDetected && r.items?.length && (r.confidence ?? 1) >= 0.5) {
      cooldownUntil = Date.now() + 15000;
      showTrashAlert(r, image);
    } else if (manual) {
      toast(r.summary || 'No litter found');
    }
    if (r.pollutionVisible && !/^none/i.test(r.pollutionVisible)) toast(`Visible pollution: ${r.pollutionVisible}`);
    if (r.roadHazardVisible && !/^none/i.test(r.roadHazardVisible)) toast(`Road hazard ahead: ${r.roadHazardVisible}`);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy = false;
    if (stream) schedule();
  }
}

function logScan(image, r) {
  const ul = $('#scan-log');
  ul.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const avatar = image ? `<img class="avatar" src="${image}" alt="" />`
    : `<span class="avatar" style="background:${r.trashDetected ? '#9C27B0' : '#4CAF50'}">${ic(r.trashDetected ? 'delete' : 'check')}</span>`;
  li.innerHTML = `${avatar}<div class="lines"><b>${r.trashDetected ? 'Litter found' : 'Clear'}</b><span>${esc(r.summary || 'Nothing on the path')}</span></div>
    <span class="meta">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
  ul.prepend(li);
  while (ul.children.length > 12) ul.lastChild.remove();
}

export async function simulateTrash() {
  if (alertOpen) return;
  showTrashAlert(null, null); // open at once with a progress state
  try {
    const r = await api('/api/ai/scan', { method: 'POST', body: { demo: true, inventory: getStash() } });
    logScan(null, r);
    showTrashAlert(r, null);
  } catch (e) {
    closeAlert();
    toast(e.message, 'err');
  }
}

// ---------------------------------------------------------------- dialog

let current = null;

export function showTrashAlert(r, thumb) {
  const dlg = $('#trash-sheet');
  alertOpen = true;
  $('#trash-backdrop').classList.remove('hidden');
  dlg.classList.remove('hidden');
  if (!r) {
    dlg.innerHTML = `<div class="dialog-body"><h2 id="trash-title">Litter detected</h2><div class="loading"><span class="spinner"></span> Identifying…</div></div>`;
    return;
  }
  current = { r, thumb };
  buzz();
  const unsafe = r.items.some((i) => i.pickupSafe === false);
  dlg.innerHTML = `
    ${thumb ? `<img class="photo" src="${thumb}" alt="Detected litter" />` : ''}
    <div class="dialog-body">
      <h2 id="trash-title">Litter detected</h2>
      <div>${esc(r.summary)}</div>
      <ul class="items">${r.items.map((i) => `<li class="${i.pickupSafe === false ? 'warn' : ''}">${esc(i.name)} (${esc(i.material)})${i.pickupSafe === false ? ', do not touch' : ''}</li>`).join('')}</ul>
      <div class="notice">Pull over safely before choosing.${unsafe ? ' Some items are unsafe to handle, so add this to the map for a clean-up crew.' : ''}</div>
      <div id="idea-box">${r.idea ? ideaHtml(r.idea, r.source) : unsafe ? '' : '<div class="idea"><div class="loading"><span class="spinner"></span> Finding a project for your stash…</div></div>'}</div>
    </div>
    <div class="dialog-actions">
      <button class="btn flat left" id="btn-not-trash">Dismiss</button>
      <button class="btn flat" id="btn-map-it">Add to map</button>
      <button class="btn flat accent-text" id="btn-pick" ${unsafe ? 'disabled' : ''}>Pick it up</button>
    </div>`;
  $('#btn-pick').onclick = pickUp;
  $('#btn-map-it').onclick = mapIt;
  $('#btn-not-trash').onclick = closeAlert;
  if (!r.idea && !unsafe) {
    api('/api/ai/upcycle', { method: 'POST', body: { items: r.items, inventory: getStash() } })
      .then(({ idea, source }) => { if (current?.r === r) { r.idea = idea; $('#idea-box').innerHTML = ideaHtml(idea, source); } })
      .catch(() => { $('#idea-box').innerHTML = ''; });
  }
}

function ideaHtml(idea, source) {
  const uses = [...(idea.usesFromHome || []), ...(idea.extraNeeded || []).map((x) => `${x} (extra)`)];
  return `<div class="idea">
    <div class="subheader" style="margin:0">Make something with it</div>
    <h3>${esc(idea.title)}</h3>
    <div class="secondary">${esc(idea.pitch)}</div>
    ${uses.length ? `<div class="uses">You'll need: ${uses.map(esc).join(', ')}</div>` : ''}
    <ol>${(idea.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <div class="secondary small">About ${idea.minutes || '?'} min, ${esc(idea.difficulty || 'easy')}. ${esc(idea.safety || '')}${source === 'gemini' ? '' : ' (offline suggestion)'}</div>
  </div>`;
}

async function pickUp() {
  const { r } = current;
  try {
    await api('/api/litter', { method: 'POST', body: { status: 'picked', items: r.items } });
    if (r.idea) saveProject(r.idea, `Litter you picked up: ${r.items.map((i) => i.name).join(', ')}`);
    closeAlert();
    toast(r.idea ? `Thanks for picking it up. "${r.idea.title}" was saved to Stash.` : 'Thanks for picking it up.', 'ok');
    window.dispatchEvent(new Event('data-changed'));
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function mapIt() {
  const { r, thumb } = current;
  const pos = currentPosition();
  try {
    const small = thumb ? await shrinkDataUrl(thumb, 320) : null;
    const l = await api('/api/litter', { method: 'POST', body: { lat: pos.lat, lng: pos.lng, items: r.items, summary: r.summary, thumb: small } });
    if (r.idea) saveProject(r.idea, `Idea from litter you reported (L${l.no})`);
    closeAlert();
    toast(`Added L${l.no} to the map`, 'ok');
    window.dispatchEvent(new Event('data-changed'));
  } catch (e) {
    toast(e.message, 'err');
  }
}

function closeAlert() {
  alertOpen = false;
  current = null;
  $('#trash-sheet').classList.add('hidden');
  $('#trash-backdrop').classList.add('hidden');
}

function buzz() {
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

// ---------------------------------------------------------------- image helpers

/** Downscale on the client: faster upload, smaller Gemini request, strips EXIF location. */
export function shrinkImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(drawScaled(img, max)); };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

function shrinkDataUrl(url, max) {
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
  return c.toDataURL('image/jpeg', 0.82);
}
