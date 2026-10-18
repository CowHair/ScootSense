import { $, $$, esc } from './ui.js';

let user = null;
let config = { googleClientId: null, database: { backend: 'local' } };
let mode = 'signin';
let resolveGate;

export const getUser = () => user;
export const isMember = () => !!user && !user.guest;
export const isDemo = () => !!user?.demo;

const CAPTIONS = ['Warming up the sensors', 'Loading the city map', 'Checking the air', 'Almost there'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const firstName = (u) => (u?.guest ? 'Explorer' : String(u?.name || 'Rider').trim().split(/\s+/)[0]);

export async function gate() {
  let i = 0;
  const cap = setInterval(() => {
    const el = $('#boot-caption');
    el.style.opacity = 0;
    setTimeout(() => { el.textContent = CAPTIONS[++i % CAPTIONS.length]; el.style.opacity = 0.75; }, 250);
  }, 1100);

  const [cfg, me, stats] = await Promise.all([
    fetch('/api/auth/config').then((r) => r.json()).catch(() => config),
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/stats').then((r) => r.json()).catch(() => null),
    wait(1700),
  ]);
  clearInterval(cap);
  config = cfg;
  window.__stats = stats;

  return new Promise((resolve) => {
    resolveGate = resolve;
    $('#boot').classList.add('done');
    setTimeout(() => $('#boot').remove(), 600);
    if (me?.user) {
      user = me.user;
      const seen = (() => { try { return sessionStorage.getItem('ss_welcomed'); } catch { return null; } })();
      if (seen) finish();
      else playWelcome(true);
    } else {
      showAuth();
    }
  });
}

function finish() {
  document.body.classList.remove('locked');
  try { sessionStorage.setItem('ss_welcomed', '1'); } catch {}
  resolveGate?.(user);
  resolveGate = null;
}

function showAuth() {
  const el = $('#auth');
  el.classList.remove('hidden');
  const db = config.database || {};
  $('#auth-foot').textContent = db.backend === 'tiger'
    ? `Accounts are stored securely in Tiger Data${db.timescale ? ` (TimescaleDB ${db.timescale})` : ''}.`
    : 'Demo mode: accounts are stored on this server only.';

  $$('.auth-tabs button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('#pw-toggle').onclick = () => {
    const pw = $('#auth-pw');
    pw.type = pw.type === 'password' ? 'text' : 'password';
    $('#pw-toggle i').textContent = pw.type === 'password' ? 'visibility' : 'visibility_off';
  };
  $('#auth-form').onsubmit = submit;
  $('#auth-guest').onclick = async () => {
    const r = await fetch('/api/auth/guest', { method: 'POST' }).then((x) => x.json());
    signedIn(r.user, false);
  };
  $('#auth-demo').onclick = async () => {
    const r = await fetch('/api/auth/demo', { method: 'POST' }).then((x) => x.json());
    signedIn(r.user, false);
  };
  setupGoogle();
  setMode(mode);
}

function setMode(m) {
  mode = m;
  $$('.auth-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#auth-ink').style.transform = `translateX(${m === 'signup' ? 100 : 0}%)`;
  $$('.signup-only').forEach((x) => x.classList.toggle('hidden', m !== 'signup'));
  $('#auth-submit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
  $('#auth-pw').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
  renderGoogleButton();
}

async function submit(e) {
  e.preventDefault();
  const btn = $('#auth-submit');
  const body = { name: $('#auth-name').value, email: $('#auth-email').value, password: $('#auth-pw').value };
  btn.classList.add('loading');
  $('#auth-error').textContent = '';
  try {
    const r = await fetch(`/api/auth/${mode === 'signup' ? 'signup' : 'login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    signedIn(data.user, mode === 'signin');
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('.auth-card').classList.remove('shake');
    void $('.auth-card').offsetWidth;
    $('.auth-card').classList.add('shake');
  } finally {
    btn.classList.remove('loading');
  }
}

function setupGoogle() {
  if (!config.googleClientId) { $('#g-fallback').classList.remove('hidden'); return; }
  if (window.google?.accounts) return renderGoogleButton();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: config.googleClientId, callback: onGoogle, ux_mode: 'popup', cancel_on_tap_outside: true });
    renderGoogleButton();
    google.accounts.id.prompt();
  };
  s.onerror = () => $('#g-fallback').classList.remove('hidden');
  document.head.append(s);
}

function renderGoogleButton() {
  if (!window.google?.accounts || !config.googleClientId) return;
  const box = $('#g-btn');
  box.replaceChildren();
  google.accounts.id.renderButton(box, {
    theme: 'outline', size: 'large', shape: 'pill', logo_alignment: 'left',
    text: mode === 'signup' ? 'signup_with' : 'continue_with', width: Math.min(352, box.clientWidth || 320),
  });
}

async function onGoogle({ credential }) {
  try {
    const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    signedIn(data.user, true);
  } catch (err) {
    $('#auth-error').textContent = err.message || 'Google sign-in failed';
  }
}

function signedIn(u, returning) {
  user = u;
  $('#auth').classList.add('leaving');
  setTimeout(() => $('#auth').classList.add('hidden'), 400);
  playWelcome(returning);
}

export async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' });
  try { sessionStorage.removeItem('ss_welcomed'); } catch {}
  location.hash = '#ride';
  location.reload();
}

function playWelcome(returning) {
  const w = $('#welcome');
  const name = firstName(user);
  $('#w-hello').textContent = user.guest ? 'Welcome,' : returning ? 'Welcome back,' : 'Welcome,';
  $('#w-name').setAttribute('aria-label', name);
  $('#w-name').innerHTML = [...name].map((ch, i) => `<span style="animation-delay:${0.6 + i * 0.06}s">${esc(ch)}</span>`).join('');
  buildStats();
  loadWeather();
  w.classList.remove('hidden');

  let done = false;
  const exit = () => {
    if (done) return;
    done = true;
    const r = $('#w-go').getBoundingClientRect();
    w.style.setProperty('--rx', `${r.left + r.width / 2}px`);
    w.style.setProperty('--ry', `${r.top + r.height / 2}px`);
    w.classList.add('exit');
    document.body.classList.add('revealing');
    finish();
    setTimeout(() => { w.remove(); document.body.classList.remove('revealing'); }, 900);
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(exit, reduce ? 1500 : 7000);
  $('#w-go').onclick = (e) => { e.stopPropagation(); exit(); };
  $('#w-skip').onclick = (e) => { e.stopPropagation(); exit(); };
  w.onclick = exit;
}

async function loadWeather() {
  const ICON = (c) => (c === 0 ? 'wb_sunny' : c <= 3 ? 'wb_cloudy' : c <= 48 ? 'cloud' : c <= 67 ? 'grain' : c <= 77 ? 'ac_unit' : c <= 82 ? 'grain' : 'flash_on');
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.784&longitude=-79.188&current=temperature_2m,weather_code').then((x) => x.json());
    $('#w-temp').textContent = `${Math.round(r.current.temperature_2m)}°C`;
    $('#w-wicon').textContent = ICON(r.current.weather_code);
  } catch {}
}

function buildStats() {
  const s = window.__stats;
  if (!s) return;
  const items = [[s.distanceKm, 'Mapped', 'km', 1], [s.hazards, 'Hazards', 'found', 0], [s.itemsPickedUp + s.litterCleared, 'Cleanups', 'done', 0]];
  $('#w-stats').innerHTML = items.map(([, label, unit], i) => `<div style="animation-delay:${0.35 + i * 0.1}s"><span>${label}</span><b data-i="${i}">0</b><em>${unit}</em></div>`).join('');
  const start = performance.now() + 500;
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - start) / 1300));
    const e = 1 - (1 - t) ** 3;
    items.forEach(([v, , , dec], i) => {
      const b = $(`#w-stats b[data-i="${i}"]`);
      if (b) b.textContent = (v * e).toFixed(dec);
    });
    if (t < 1 && document.body.contains($('#w-stats'))) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
