// The rider's home stash of reusable stuff and their saved upcycle projects.
// Signed-in riders keep them in Tiger Data; guests keep them on this device.
// localStorage doubles as an offline cache either way.
import { $, api, toast, esc, ic, skeletonText } from './ui.js';
import { shrinkImage, shrinkDataUrl } from './scan.js';
import { isMember } from './auth.js';

const KEY_STASH = 'scootsense.stash';
const KEY_PROJ = 'scootsense.projects';
const QUICK = ['glass jars', 'plastic bottles', 'cardboard boxes', 'tin cans', 'old t-shirts'];

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const getStash = () => read(KEY_STASH, [
  { name: 'glass jars', material: 'glass', qty: 3 },
  { name: 'old t-shirts', material: 'textile', qty: 2 },
  { name: 'cardboard boxes', material: 'cardboard', qty: 2 },
  { name: 'string', material: 'textile', qty: 1 },
]);
let pushTimer = null;
function setStash(s) {
  write(KEY_STASH, s);
  render();
  if (!isMember()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => api('/api/me/stash', { method: 'PUT', body: { items: s } }).catch((e) => toast(`Could not save stash: ${e.message}`, 'err')), 600);
}

export async function saveProject(idea, origin) {
  let saved = { ...idea, origin, savedAt: new Date().toISOString() };
  if (isMember()) {
    try { saved = await api('/api/me/projects', { method: 'POST', body: { idea, origin } }); } catch (e) { toast(`Saved on this device only: ${e.message}`, 'err'); }
  }
  const list = read(KEY_PROJ, []);
  list.unshift(saved);
  write(KEY_PROJ, list.slice(0, 50));
  renderProjects();
  return saved;
}

/** After sign-in: pull the account's stash and projects, migrating local items up on first use. */
export async function syncStash(user) {
  if (!user || user.guest) { loadTrashList(); return; }
  $('#projects').innerHTML = skeletonText(3);
  try {
    let [stash, projects] = await Promise.all([api('/api/me/stash'), api('/api/me/projects')]);
    if (!stash.length) stash = await api('/api/me/stash', { method: 'PUT', body: { items: getStash() } });
    write(KEY_STASH, stash);
    write(KEY_PROJ, projects);
  } catch (e) {
    toast(`Using the copy on this device: ${e.message}`, 'err');
  }
  render();
  renderProjects();
  loadTrashList();
}

// ---------------------------------------------------------------- trash list (what the rider picked up)

const MAT_COLOR = { plastic: '#2196F3', glass: '#00BCD4', metal: '#607D8B', paper: '#795548', cardboard: '#8D6E63', textile: '#9C27B0', organic: '#4CAF50' };

async function loadTrashList() {
  const ul = $('#trash-list');
  if (!isMember()) {
    ul.innerHTML = '<li class="empty">Sign in to keep a list of the litter you pick up.</li>';
    $('#trash-count').textContent = '';
    return;
  }
  try {
    const list = await api('/api/me/trash');
    $('#trash-count').textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : '';
    ul.innerHTML = list.map((t) => `<li>
        ${t.photo ? `<img class="avatar" src="${t.photo}" alt="" />` : `<span class="avatar" style="background:${MAT_COLOR[t.material] || '#9E9E9E'}">${ic('delete')}</span>`}
        <div class="lines"><b>${esc(t.name)}</b><span>${esc(t.material || 'litter')} · ${new Date(t.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${t.source === 'camera' ? 'scooter camera' : t.source === 'map' ? 'from the map' : 'phone'}</span></div>
        <button class="icon-btn dark" data-trash="${t.id}" aria-label="Remove">${ic('close')}</button></li>`).join('')
      || '<li class="empty">Litter you pick up on rides is listed here.</li>';
  } catch {
    ul.innerHTML = '<li class="empty">Could not load your trash list.</li>';
  }
}

async function onTrashChanged() {
  if (!isMember()) return;
  // Picking something up also adds it to the home stash on the server.
  try { write(KEY_STASH, await api('/api/me/stash')); write(KEY_PROJ, await api('/api/me/projects')); } catch {}
  render();
  renderProjects();
  loadTrashList();
}

export function initStash() {
  window.addEventListener('trash-changed', onTrashChanged);
  $('#trash-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-trash]');
    if (!b) return;
    await api(`/api/me/trash/${b.dataset.trash}`, { method: 'DELETE' });
    loadTrashList();
  });
  $('#stash-quick').innerHTML = QUICK.map((q) => `<button type="button" data-q="${q}">${q}</button>`).join('');
  $('#stash-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (b) add(b.dataset.q, 1);
  });
  $('#stash-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#stash-name').value.trim();
    if (!name) return;
    add(name, Number($('#stash-qty').value) || 1);
    $('#stash-name').value = '';
    $('#stash-qty').value = 1;
  });
  $('#stash-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const s = getStash();
    const i = Number(b.dataset.i);
    if (b.dataset.act === 'minus' && s[i].qty > 1) s[i].qty--;
    else s.splice(i, 1);
    setStash(s);
  });
  $('#stash-photo').addEventListener('change', (e) => fromPhoto(e.target.files[0]));
  $('#btn-stash-idea').addEventListener('click', ideaFromStash);
  $('#projects').addEventListener('click', async (e) => {
    const pic = e.target.closest('[data-picture]');
    if (pic) return pictureProject(Number(pic.dataset.picture), pic);
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const list = read(KEY_PROJ, []);
    const [gone] = list.splice(Number(b.dataset.del), 1);
    write(KEY_PROJ, list);
    renderProjects();
    if (isMember() && gone?.id) api(`/api/me/projects/${gone.id}`, { method: 'DELETE' }).catch(() => {});
  });
  render();
  renderProjects();
}

function add(name, qty, material = '') {
  const s = getStash();
  const hit = s.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (hit) hit.qty += qty;
  else s.push({ name, material, qty });
  setStash(s);
}

function render() {
  const s = getStash();
  $('#stash-list').innerHTML = s.map((x, i) => `<li><span class="avatar" style="background:#009688">${x.qty}</span>
    <div class="lines"><b>${esc(x.name)}</b>${x.material ? `<span>${esc(x.material)}</span>` : ''}</div>
    <button class="icon-btn dark" data-i="${i}" aria-label="Delete">${ic('delete')}</button></li>`).join('')
    || '<li class="empty">Your stash is empty.</li>';
}

function renderProjects() {
  const list = read(KEY_PROJ, []);
  $('#proj-count').textContent = list.length ? `${list.length} saved` : '';
  $('#projects').innerHTML = list.map((p, i) => `<details class="project">
      <summary>${p.image ? `<img class="proj-thumb" src="${p.image}" alt="" />` : `<span class="proj-thumb empty-thumb">${ic('construction')}</span>`}
        <span class="proj-title">${esc(p.title)}</span><span class="secondary small">${p.minutes || '?'} min</span></summary>
      ${p.image ? `<img class="proj-image" src="${p.image}" alt="Picture of the finished ${esc(p.title)}" />`
        : `<button class="btn flat" data-picture="${i}">${ic('auto_awesome')} Picture it with Gemini</button>`}
      <p class="secondary">${esc(p.pitch)}</p>
      ${p.origin ? `<p class="secondary small">${esc(p.origin)}</p>` : ''}
      <ol>${(p.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <button class="btn flat danger" data-del="${i}">Delete</button>
    </details>`).join('') || '<p class="empty">Saved project ideas appear here.</p>';
}

/** Generate a picture of a saved project and keep a compressed copy with it. */
async function pictureProject(i, btn) {
  const list = read(KEY_PROJ, []);
  const p = list[i];
  if (!p) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Drawing…';
  try {
    const r = await api('/api/ai/project-image', { method: 'POST', body: { idea: p } });
    if (r.error) throw new Error(r.error);
    p.image = await shrinkDataUrl(r.image, 640);
    write(KEY_PROJ, list);
    if (isMember() && p.id) await api(`/api/me/projects/${p.id}/image`, { method: 'PUT', body: { image: p.image } });
    renderProjects();
    $(`#projects details:nth-child(${i + 1})`)?.setAttribute('open', '');
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = `${ic('auto_awesome')} Picture it with Gemini`;
  }
}

async function fromPhoto(file) {
  if (!file) return;
  toast('Reading your photo…');
  try {
    const image = await shrinkImage(file, 1024);
    const out = await api('/api/ai/inventory-scan', { method: 'POST', body: { image } });
    out.items.forEach((i) => add(i.name, i.qty || 1, i.material));
    toast(`Added ${out.items.length} item${out.items.length === 1 ? '' : 's'} from your photo`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  $('#stash-photo').value = '';
}

async function ideaFromStash() {
  const btn = $('#btn-stash-idea');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  try {
    const { idea, source } = await api('/api/ai/upcycle', { method: 'POST', body: { items: [], inventory: getStash() } });
    await saveProject(idea, source === 'gemini' ? 'Suggested by Gemini from your stash' : 'Offline suggestion');
    toast(`New project: ${idea.title}`, 'ok');
    $('#projects details')?.setAttribute('open', '');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get a new idea';
  }
}
