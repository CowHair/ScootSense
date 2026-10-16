// The rider's home stash of reusable stuff and their saved upcycle projects.
// Signed-in riders keep them in Tiger Data; guests keep them on this device.
// localStorage doubles as an offline cache either way.
import { $, api, toast, esc, ic, skeletonText } from './ui.js';
import { shrinkImage } from './scan.js';
import { isMember } from './auth.js';

const KEY_STASH = 'scootsense.stash';
const KEY_PROJ = 'scootsense.projects';
const QUICK = ['glass jars', 'plastic bottles', 'cardboard boxes', 'tin cans', 'old t-shirts', 'egg cartons', 'wine corks', 'string', 'bottle caps', 'newspapers'];

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
}

/** After sign-in: pull the account's stash and projects, migrating local items up on first use. */
export async function syncStash(user) {
  if (!user || user.guest) return;
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
}

export function initStash() {
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
  $('#projects').addEventListener('click', (e) => {
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
    <button class="icon-btn dark" data-i="${i}" data-act="minus" aria-label="Remove one">${ic('remove')}</button>
    <button class="icon-btn dark" data-i="${i}" aria-label="Delete">${ic('delete')}</button></li>`).join('')
    || '<li class="empty">Your stash is empty.</li>';
}

function renderProjects() {
  const list = read(KEY_PROJ, []);
  $('#proj-count').textContent = list.length ? `${list.length} saved` : '';
  $('#projects').innerHTML = list.map((p, i) => `<details>
      <summary><span>${esc(p.title)}</span><span class="secondary small">${p.minutes || '?'} min</span></summary>
      <p class="secondary">${esc(p.pitch)}</p>
      ${p.origin ? `<p class="secondary small">${esc(p.origin)}</p>` : ''}
      <ol>${(p.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <button class="btn flat danger" data-del="${i}">Delete</button>
    </details>`).join('') || '<p class="empty">Saved project ideas appear here.</p>';
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
    btn.textContent = 'Suggest a project';
  }
}
