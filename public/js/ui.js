import { CLASS_INFO } from '/shared/signal.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// Material indeterminate progress bar under the toolbar while requests are in flight.
let inflight = 0, progressTimer = null;
function progress(delta) {
  inflight = Math.max(0, inflight + delta);
  clearTimeout(progressTimer);
  const bar = document.getElementById('progress');
  if (!bar) return;
  if (inflight) progressTimer = setTimeout(() => bar.classList.remove('hidden'), 150);
  else bar.classList.add('hidden');
}

export async function api(path, { method = 'GET', body } = {}) {
  progress(1);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  } finally {
    progress(-1);
  }
}

/** Shimmer placeholders shown while content loads. */
export const skeletonRows = (n = 3) => Array.from({ length: n }, (_, i) =>
  `<li class="skel-row"><span class="skel c"></span><span class="l"><span class="skel skel-line ${i % 2 ? 'w60' : 'w80'}"></span><span class="skel skel-line w40"></span></span></li>`).join('');
export const skeletonText = (n = 4) => `<div class="skel-block">${Array.from({ length: n }, (_, i) =>
  `<span class="skel skel-line ${['w80', '', 'w60', 'w40'][i % 4]}"></span>`).join('')}</div>`;

/** Material snackbar: one message at a time. */
export function toast(msg, kind = '') {
  $('#toasts').replaceChildren();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Render Gemini Markdown safely and turn hazard ids (H12) into map links. */
export function md(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''));
  return html.replace(/(?<![\w/#])H(\d{1,4})\b(?![^<]*>)/g, '<a class="hz-link" data-hz="$1">H$1</a>');
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('.hz-link');
  if (!a) return;
  e.preventDefault();
  location.hash = `#map/${a.dataset.hz}`;
});

export const classColor = (c) => CLASS_INFO[c]?.color || '#9E9E9E';
export const ic = (name) => `<i class="material-icons">${name}</i>`;
export const classLabel = (c) => CLASS_INFO[c]?.label || c;

/** Green → yellow → red for a 0-100 roughness score. */
export function scoreColor(score) {
  const s = Math.max(0, Math.min(100, score)) / 100;
  const stops = [[76, 175, 80], [255, 193, 7], [255, 152, 0], [244, 67, 54]];
  const x = s * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + f * (stops[i + 1][k] - v)));
  return `rgb(${c.join(',')})`;
}

export const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtDur = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function tileLayer() {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
}

/** Esri World Imagery with road and place-name overlays, for the city map. */
export function satelliteLayers() {
  const esri = (path, opts = {}) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`,
    { maxNativeZoom: 19, maxZoom: 20, ...opts });
  return [
    esri('World_Imagery', { attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community' }),
    esri('Reference/World_Transportation', { opacity: 0.55 }),
    esri('Reference/World_Boundaries_and_Places', { opacity: 0.9 }),
  ];
}

export const DEFAULT_CENTER = [43.7843, -79.1885];

Chart.defaults.color = 'rgba(0,0,0,.54)';
Chart.defaults.borderColor = 'rgba(0,0,0,.08)';
Chart.defaults.font.family = 'Roboto, Arial, sans-serif';
