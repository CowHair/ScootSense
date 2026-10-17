import { $, $$, api, toast, esc } from './ui.js';
import { sensor } from './sensor.js';
import { initLive, onShowLive } from './live.js';
import { initMap, onShowMap } from './map.js';
import { initInsights } from './insights.js';
import { initTrain, onShowTrain } from './train.js';
import { initImpact, onShowImpact } from './impact.js';
import { initScan, startCameraPolling } from './scan.js';
import { initLitterWatch } from './litterwatch.js';
import { initStash, syncStash } from './stash.js';
import { gate, signOut } from './auth.js';
import { initProfile, onShowProfile } from './profile.js';

const onShow = { ride: onShowLive, map: onShowMap, train: onShowTrain, impact: onShowImpact, device: loadDevice, profile: onShowProfile };
const VIEWS = new Set($$('.view').map((v) => v.dataset.view));
const TABBED = new Set(['ride', 'map', 'scan', 'stash']);

async function boot() {
  // Build every screen behind the boot loader so the app is ready the moment it is revealed.
  initLive();
  initMap();
  initInsights();
  initTrain();
  initImpact();
  initScan();
  initLitterWatch();
  initStash();
  initProfile();
  initDevice();
  initDrawer();
  initInstall();

  const user = await gate();
  showUser(user);
  syncStash(user);
  startCameraPolling();

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', moveIndicator);
  document.fonts?.ready.then(moveIndicator); // tab widths change once Roboto loads
  route();

  sensor.model = await api('/api/model').catch(() => null);
  const { gemini: g } = await api('/api/status');
  $('#gemini-pill').textContent = g.enabled ? `Gemini connected (${g.model})` : 'Gemini not configured. AI features use offline fallbacks.';
}

function showUser(u) {
  const initial = (u.name || '?').trim()[0]?.toUpperCase() || '?';
  for (const el of [$('#drawer-avatar'), $('#profile-avatar')]) {
    el.textContent = u.picture ? '' : initial;
    el.style.backgroundImage = u.picture ? `url("${u.picture}")` : '';
  }
  $('#drawer-name').textContent = u.guest ? 'Guest' : u.name;
  $('#drawer-sub').textContent = u.guest ? 'Not signed in' : u.email || 'Signed in with Google';
  $('#signout-label').textContent = u.guest ? 'Sign in' : 'Sign out';
}

function route() {
  let [view, arg] = (location.hash.slice(1) || 'ride').split('/');
  if (view === 'live') view = 'ride';
  if (!VIEWS.has(view)) view = 'ride';
  const el = $(`.view[data-view="${view}"]`);
  $$('.view').forEach((v) => v.classList.toggle('active', v === el));
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  $$('.drawer-list a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  $('#appbar-title').textContent = el.dataset.title;
  document.body.classList.toggle('no-tabs', !TABBED.has(view));
  document.body.classList.toggle('map-mode', view === 'map');
  closeDrawer();
  moveIndicator();
  if (view !== 'map') window.scrollTo(0, 0);
  onShow[view]?.(arg);
}

function moveIndicator() {
  const a = $('#tabs a.active');
  const bar = $('#tab-indicator');
  if (!a) return;
  bar.style.width = `${a.offsetWidth}px`;
  bar.style.transform = `translateX(${a.offsetLeft}px)`;
}

// ---------------------------------------------------------------- navigation drawer

function initDrawer() {
  $('#menu-btn').addEventListener('click', () => {
    $('#drawer').classList.add('open');
    $('#scrim').classList.remove('hidden');
  });
  $('#scrim').addEventListener('click', closeDrawer);
  $('#btn-signout').addEventListener('click', (e) => { e.preventDefault(); signOut(); });
  $('#btn-guest-signup').addEventListener('click', signOut);
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.add('hidden');
}

// ---------------------------------------------------------------- install prompt (Android / desktop Chrome)

function initInstall() {
  let deferred = null;
  $('#install-card').classList.add('hidden');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#install-card').classList.remove('hidden');
  });
  $('#btn-install').addEventListener('click', async (e) => {
    e.preventDefault();
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#install-card').classList.add('hidden');
  });
}

// ---------------------------------------------------------------- device & privacy

function initDevice() {
  $('#loc-dec').addEventListener('change', async (e) => {
    await api('/api/settings', { method: 'PATCH', body: { locationDecimals: Number(e.target.value) } });
    toast('Location precision updated for new data', 'ok');
  });
  $('#zones').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-zone]');
    if (!b) return;
    const { settings } = await api('/api/status');
    settings.privacyZones.splice(Number(b.dataset.zone), 1);
    await api('/api/settings', { method: 'PATCH', body: { privacyZones: settings.privacyZones } });
    window.dispatchEvent(new Event('data-changed'));
    loadDevice();
  });
  $('#btn-reset-demo').addEventListener('click', () => resetData(true));
  $('#btn-wipe').addEventListener('click', () => resetData(false));
}

async function resetData(seed) {
  if (!confirm(seed ? 'Replace community data with fresh demo data?' : 'Permanently delete all community rides, hazards, litter and training data? Accounts are kept.')) return;
  await api('/api/demo/reset', { method: 'POST', body: { seed } });
  toast(seed ? 'Demo data restored' : 'Community data deleted', 'ok');
  setTimeout(() => location.reload(), 600);
}

async function loadDevice() {
  const s = await api('/api/status');
  $('#loc-dec').value = String(s.settings.locationDecimals);
  $('#zones').innerHTML = s.settings.privacyZones.map((z, i) =>
    `<li><div class="lines"><b>${z.lat.toFixed(4)}, ${z.lng.toFixed(4)}</b><span>${z.radius} m radius</span></div>
      <button class="btn flat danger" data-zone="${i}">Remove</button></li>`).join('')
    || '<li class="empty">No privacy zones yet.</li>';
  $('#lan-urls').innerHTML = s.lanUrls.length
    ? 'SERVER_URL:<br>' + s.lanUrls.map((u) => `<code>${esc(u)}/api/ingest</code>`).join('<br>')
    : '<span class="secondary">No network address found.</span>';
}


boot().catch((e) => toast('Failed to start: ' + e.message, 'err'));
