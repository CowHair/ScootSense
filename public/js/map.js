// City map in the style of Google Maps (2015): search box, layers menu, pins,
// my-location FAB and a bottom sheet listing nearby potholes, litter and air hotspots.
import { $, api, toast, esc, ic, skeletonRows, classColor, scoreColor, fmtDate, tileLayer, DEFAULT_CENTER } from './ui.js';
import { pmBand } from '/shared/signal.js';
import { locateOnce } from './geo.js';
import { shrinkImage } from './scan.js';

let map;
const layers = {};
let data = { hazards: [], litter: [], hot: [], grid: [] };
let loaded = false;
let open = null; // { kind, id }
let meMarker = null;

const ICON = { bump: 'warning', rough: 'texture', litter: 'delete', air: 'cloud' };
const LITTER = '#9C27B0';

export function initMap() {
  map = L.map('city-map', { zoomControl: false, preferCanvas: true }).setView(DEFAULT_CENTER, 16);
  tileLayer().addTo(map);
  for (const k of ['rough', 'air', 'hazards', 'litter', 'zones']) layers[k] = L.layerGroup().addTo(map);

  $('#fab-layers').addEventListener('click', (e) => { e.stopPropagation(); $('#layer-chips').classList.toggle('hidden'); });
  $('#layer-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layer]');
    if (!b) return;
    b.classList.toggle('on');
    const g = layers[b.dataset.layer];
    b.classList.contains('on') ? g.addTo(map) : g.remove();
    renderList();
  });
  $('#hz-filter').addEventListener('change', reload);
  $('#sheet-handle').addEventListener('click', () => setSheet(!$('#map-sheet').classList.contains('expanded')));
  $('#fab-locate').addEventListener('click', locate);
  $('#fab-zone').addEventListener('click', addZone);
  map.on('moveend', renderList);
  map.on('click', () => {
    if (open) closeDetail();
    setSheet(false);
    $('#search-results').classList.add('hidden');
    $('#layer-chips').classList.add('hidden');
  });

  $('#map-search').addEventListener('submit', (e) => { e.preventDefault(); search($('#map-q').value); });
  $('#map-q').addEventListener('input', (e) => {
    $('#map-q-clear').classList.toggle('hidden', !e.target.value);
    clearTimeout(searchTimer);
    if (e.target.value.trim().length >= 3) searchTimer = setTimeout(() => search(e.target.value), 450);
  });
  $('#map-q-clear').addEventListener('click', () => { $('#map-q').value = ''; $('#search-results').classList.add('hidden'); $('#map-q-clear').classList.add('hidden'); });
  window.addEventListener('data-changed', () => (loaded = false));
}

export async function onShowMap(arg) {
  map.invalidateSize(); // the view was display:none until now
  if (!loaded) {
    const first = !data.hazards.length;
    loaded = true;
    if (first) $('#hz-list').innerHTML = skeletonRows(4);
    await reload();
    const pts = [...data.hazards, ...data.litter].map((p) => [p.lat, p.lng]);
    // Frame the data between the search box and the bottom sheet.
    if (first && pts.length && !arg) {
      const wide = innerWidth >= 960;
      map.fitBounds(pts, { paddingTopLeft: [wide ? 420 : 16, 70], paddingBottomRight: [wide ? 16 : 56, wide ? 16 : 170], maxZoom: 17 });
    }
  }
  if (arg) {
    const kind = /^L/i.test(arg) ? 'litter' : 'hazard';
    openDetail(kind, arg.replace(/^[LH]/i, ''), true);
  }
}

async function reload() {
  const status = $('#hz-filter').value;
  const [hazards, litter, hot, grid, st] = await Promise.all([
    api(`/api/hazards${status ? '?status=' + status : ''}`), api('/api/litter'), api('/api/pollution'), api('/api/grid'), api('/api/status'),
  ]);
  data = { hazards, litter, hot, grid };
  draw(st.settings.privacyZones);
  renderList();
  if (open) openDetail(open.kind, open.id);
}

function pin(icon, color, cls = '', badge = '') {
  return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 36],
    html: `<div class="pin ${cls}" style="background:${color}">${ic(icon)}${badge ? `<b>${badge}</b>` : ''}</div>` });
}

function draw(zones) {
  Object.values(layers).forEach((g) => g.clearLayers());
  for (const c of data.grid) {
    L.circle([c.lat, c.lng], { radius: 12, stroke: false, fillColor: scoreColor(c.score * 1.6), fillOpacity: 0.35, interactive: false }).addTo(layers.rough);
    if (c.pm25 !== null && c.pm25 > 12) {
      L.circle([c.lat, c.lng], { radius: 22, stroke: false, fillColor: pmBand(c.pm25).color, fillOpacity: 0.18, interactive: false }).addTo(layers.air);
    }
  }
  data.hot.forEach((c, i) => {
    L.marker([c.lat, c.lng], { icon: pin(ICON.air, pmBand(c.pm25).color, '', Math.round(c.pm25)) })
      .on('click', () => openDetail('air', String(i), false)).addTo(layers.air);
  });
  for (const h of data.hazards) {
    L.marker([h.lat, h.lng], { icon: pin(ICON[h.type] || 'warning', classColor(h.type), h.status, h.reports > 1 ? h.reports : ''), title: `H${h.no}` })
      .on('click', () => openDetail('hazard', h.no, false)).addTo(layers.hazards);
  }
  for (const l of data.litter) {
    L.marker([l.lat, l.lng], { icon: pin(ICON.litter, LITTER), title: `L${l.no}` })
      .on('click', () => openDetail('litter', l.no, false)).addTo(layers.litter);
  }
  for (const z of zones) {
    L.circle([z.lat, z.lng], { radius: z.radius, color: '#2196F3', weight: 1.5, dashArray: '4 4', fillOpacity: 0.06 })
      .bindTooltip('Privacy zone').addTo(layers.zones);
  }
}

const on = (layer) => $(`#layer-chips [data-layer=${layer}]`).classList.contains('on');
const fmtD = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

function renderList() {
  if (!map) return;
  const c = map.getCenter();
  const dist = (p) => map.distance(c, [p.lat, p.lng]);
  const items = [
    ...(on('hazards') ? data.hazards.map((h) => ({ kind: 'hazard', id: h.no, p: h, d: dist(h) })) : []),
    ...(on('litter') ? data.litter.map((l) => ({ kind: 'litter', id: l.no, p: l, d: dist(l) })) : []),
    ...(on('air') ? data.hot.map((h, i) => ({ kind: 'air', id: String(i), p: h, d: dist(h) })) : []),
  ].sort((a, b) => a.d - b.d).slice(0, 40);
  $('#hz-list').innerHTML = items.map(({ kind, id, p, d }) => {
    if (kind === 'hazard') return row(kind, id, ICON[p.type], classColor(p.type), `${p.typeLabel} (H${p.no})`, `${fmtD(d)} · seen on ${p.reports} ride${p.reports > 1 ? 's' : ''} · ${p.status}`);
    if (kind === 'litter') return row(kind, id, ICON.litter, LITTER, `Litter (L${p.no})`, `${fmtD(d)} · ${p.items.map((i) => i.name).join(', ')}`);
    return row(kind, id, ICON.air, pmBand(p.pm25).color, `Poor air: ${Math.round(p.pm25)} µg/m³`, `${fmtD(d)} · ${pmBand(p.pm25).label}`);
  }).join('') || '<li class="empty">Nothing nearby. Check the layers menu.</li>';
  $('#hz-list').querySelectorAll('li[data-kind]').forEach((li) => li.addEventListener('click', () => openDetail(li.dataset.kind, li.dataset.id, true)));
}

const row = (kind, id, icon, color, title, sub) => `<li data-kind="${kind}" data-id="${id}">
  <span class="avatar" style="background:${color}">${ic(icon)}</span>
  <div class="lines"><b>${esc(title)}</b><span>${esc(sub)}</span></div></li>`;

function setSheet(expanded) {
  $('#map-sheet').classList.toggle('expanded', expanded);
  document.body.classList.toggle('sheet-open', expanded);
}

const directions = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=bicycling`;
const head = (icon, color, title, sub, img) => `<div class="detail-head">
  ${img ? `<img src="${img}" alt="" />` : `<span class="avatar" style="background:${color}">${ic(icon)}</span>`}
  <div><div class="title">${title}</div><div class="secondary">${sub}</div></div></div>`;

async function openDetail(kind, id, fly) {
  open = { kind, id: String(id) };
  const box = $('#sheet-detail');
  let p;
  if (kind === 'hazard') {
    try { p = await api(`/api/hazards/${id}`); } catch { return toast(`H${id} not found`, 'err'); }
    box.innerHTML = hazardHtml(p);
    wireHazard(p);
  } else if (kind === 'litter') {
    try { p = await api(`/api/litter/${id}`); } catch { return toast(`L${id} is no longer on the map`, 'err'); }
    box.innerHTML = litterHtml(p);
    box.querySelectorAll('[data-check]').forEach((b) => (b.onclick = async () => {
      const r = await api(`/api/litter/${p.no}/check`, { method: 'POST', body: { answer: b.dataset.check } });
      toast(r.status === 'cleared' ? 'Thanks, it has been taken off the map.' : b.dataset.check === 'still' ? 'Thanks, marked as still there.' : "Thanks. One more 'gone' answer removes it.", 'ok');
      if (b.dataset.check === 'picked') window.dispatchEvent(new Event('trash-changed'));
      if (r.status === 'cleared') closeDetail();
      reload();
    }));
  } else {
    p = data.hot[Number(id)];
    if (!p) return;
    const b = pmBand(p.pm25);
    box.innerHTML = `<div class="detail">
      ${head(ICON.air, b.color, `${Math.round(p.pm25)} µg/m³ PM2.5`, b.label)}
      <div class="detail-actions"><a href="${directions(p)}" target="_blank" rel="noopener">${ic('directions')}Directions</a><button id="hz-back">${ic('arrow_back')}Back</button></div>
      <div class="kv"><div><b>${p.n}</b><span>Readings here</span></div><div><b>${(p.pm25 / 15).toFixed(1)}x</b><span>WHO daily guideline</span></div></div>
      <p class="secondary">Average street-level reading from scooter sensors. Consider a parallel street, especially with asthma or at busy times.</p></div>`;
  }
  $('#hz-back').onclick = closeDetail;
  box.classList.remove('hidden');
  $('#sheet-list').classList.add('hidden');
  setSheet(true);
  if (fly) map.flyTo([p.lat, p.lng], 18, { duration: 0.6 });
}

function hazardHtml(h) {
  const photos = h.photos.slice().reverse().map((ph) => {
    const a = ph.analysis || {};
    return `<div class="photo-row">${ph.file ? `<img src="/photos/${ph.file}" alt="Hazard photo" />` : ''}
      <div><b>${a.isRoadDefect === true ? 'Defect visible' : a.isRoadDefect === false ? 'No defect visible' : 'Not assessed'}</b>${a.severity ? `, severity ${a.severity}/5` : ''}
      <div class="secondary">${esc(a.summary || '')}</div>${a.accessibilityImpact ? `<div class="secondary small">Accessibility: ${esc(a.accessibilityImpact)}</div>` : ''}</div></div>`;
  }).join('');
  return `<div class="detail">
    ${head(ICON[h.type] || 'warning', classColor(h.type), `${esc(h.typeLabel)} (H${h.no})`, `<span class="status ${h.status}">${h.status[0].toUpperCase() + h.status.slice(1)}</span> · priority ${h.priority}`)}
    <div class="detail-actions">
      <a href="${directions(h)}" target="_blank" rel="noopener">${ic('directions')}Directions</a>
      <button data-vote="confirm">${ic('thumb_up')}Confirm</button>
      <button data-vote="dismiss">${ic('thumb_down')}Not a hazard</button>
      <button data-vote="fixed">${ic('build')}Fixed</button>
    </div>
    <div><div class="secondary small">Detection confidence ${Math.round(h.confidence * 100)}%</div><div class="meter"><i style="width:${h.confidence * 100}%"></i></div></div>
    <div class="kv">
      <div><b>${h.reports}</b><span>Independent rides</span></div>
      <div><b>${h.severity}</b><span>Roughness (of 100)</span></div>
      <div><b>${h.votes.confirm} / ${h.votes.dismiss}</b><span>Confirmed / dismissed</span></div>
      <div><b>${Math.round(h.detectionRate * 100)}%</b><span>Of rides detect it</span></div>
    </div>
    <div class="secondary small">First seen ${fmtDate(h.firstSeen)}, last seen ${fmtDate(h.lastSeen)}</div>
    <div class="subheader">Photos</div>
    <label class="upload" id="hz-drop"><input type="file" accept="image/*" capture="environment" hidden id="hz-file" />${ic('add_a_photo')} Add a photo for Gemini to check</label>
    ${photos}
    <div class="subheader">Notes</div>
    ${h.notes.map((n) => `<div>${esc(n.text)} <span class="secondary small">${fmtDate(n.at)}</span></div>`).join('') || '<div class="secondary">No notes yet.</div>'}
    <form class="note-form" id="hz-note"><div class="textfield" style="flex:1"><input placeholder=" " maxlength="500" id="hz-note-in" /><label for="hz-note-in">Add a note</label></div><button class="btn flat">Add</button></form>
    <button class="btn flat" id="hz-back" style="align-self:flex-start">Back to list</button>
  </div>`;
}

function wireHazard(h) {
  $('#sheet-detail').querySelectorAll('[data-vote]').forEach((b) => (b.onclick = async () => {
    await api(`/api/hazards/${h.no}/vote`, { method: 'POST', body: { vote: b.dataset.vote } });
    toast('Thanks, your vote was recorded', 'ok');
    reload();
  }));
  $('#hz-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#hz-drop').innerHTML = '<span class="spinner"></span> Checking photo…';
    try {
      const out = await api(`/api/hazards/${h.no}/photo`, { method: 'POST', body: { image: await shrinkImage(f, 1280) } });
      toast(out.photo.analysis.summary, out.photo.analysis.source === 'gemini' ? 'ok' : '');
    } catch (err) { toast(err.message, 'err'); }
    reload();
  };
  $('#hz-note').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input');
    if (!input.value.trim()) return;
    await api(`/api/hazards/${h.no}/notes`, { method: 'POST', body: { text: input.value } });
    openDetail('hazard', h.no);
  };
}

function litterHtml(l) {
  const checks = l.checks || [];
  const still = checks.filter((c) => c.answer === 'still').length;
  const gone = checks.filter((c) => c.answer === 'gone').length;
  return `<div class="detail">
    ${l.photo ? `<img class="detail-photo" src="${l.photo}" alt="Litter seen by a scooter camera" />` : ''}
    ${head(ICON.litter, LITTER, `Litter (L${l.no})`, `Reported ${fmtDate(l.at)}`)}
    <div class="detail-actions">
      <a href="${directions(l)}" target="_blank" rel="noopener">${ic('directions')}Directions</a>
      <button data-check="still">${ic('visibility')}Still here</button>
      <button data-check="gone">${ic('visibility_off')}Gone</button>
      <button data-check="picked">${ic('done')}Picked up</button>
    </div>
    <div>${esc(l.summary || '')}</div>
    <ul class="items">${l.items.map((i) => `<li>${esc(i.name)}${i.material ? ` (${esc(i.material)})` : ''}</li>`).join('')}</ul>
    <div class="kv"><div><b>${fmtDate(l.lastSeen || l.at)}</b><span>Last seen</span></div><div><b>${still} / ${gone}</b><span>Still here / gone answers</span></div></div>
    <p class="secondary small">Riders passing within 40 m are asked whether it's still here. Two "gone" answers or one pickup removes the pin.</p>
    <button class="btn flat" id="hz-back" style="align-self:flex-start">Back to list</button>
  </div>`;
}

function closeDetail() {
  open = null;
  $('#sheet-detail').classList.add('hidden');
  $('#sheet-list').classList.remove('hidden');
  if (location.hash.startsWith('#map/')) history.replaceState(null, '', '#map');
}

async function locate() {
  try {
    const p = await locateOnce();
    if (!meMarker) meMarker = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', iconSize: [16, 16], html: '<div class="me-dot"></div>' }) }).addTo(map);
    meMarker.setLatLng([p.lat, p.lng]);
    map.flyTo([p.lat, p.lng], 17);
  } catch (e) {
    toast(e.message, 'err');
  }
}

let searchTimer = null;
async function search(q) {
  q = q.trim();
  if (q.length < 3) return;
  const c = map.getCenter();
  const vb = [c.lng - 0.15, c.lat + 0.1, c.lng + 0.15, c.lat - 0.1].join(',');
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&viewbox=${vb}&q=${encodeURIComponent(q)}`).then((r) => r.json());
    const ul = $('#search-results');
    ul.innerHTML = res.map((r, i) => {
      const [name, ...rest] = r.display_name.split(', ');
      return `<li data-i="${i}">${esc(name)}<small>${esc(rest.slice(0, 3).join(', '))}</small></li>`;
    }).join('') || '<li class="secondary">No results</li>';
    ul.classList.remove('hidden');
    ul.querySelectorAll('li[data-i]').forEach((li) => (li.onclick = () => {
      const r = res[Number(li.dataset.i)];
      map.flyTo([Number(r.lat), Number(r.lon)], 17);
      ul.classList.add('hidden');
      $('#map-q').blur();
    }));
  } catch {
    toast('Search is unavailable right now', 'err');
  }
}

async function addZone() {
  const { settings } = await api('/api/status');
  const c = map.getCenter();
  await api('/api/settings', { method: 'PATCH', body: { privacyZones: [...settings.privacyZones, { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), radius: 150 }] } });
  toast('Privacy zone added at the map centre (150 m)', 'ok');
  reload();
}
