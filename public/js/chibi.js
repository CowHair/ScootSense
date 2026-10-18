import { $, api, toast, esc } from './ui.js';
import { getUser, isMember } from './auth.js';
import { stagger } from './intro.js';

const KEY = 'ss-chibi';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

export const MOTIONS = [
  ['bounce', 'Bounce', 'Hops on the spot'],
  ['float', 'Float', 'Drifts up and down'],
  ['wiggle', 'Wiggle', 'Sways side to side'],
  ['scoot', 'Scoot', 'Rolls back and forth'],
  ['still', 'Still', 'Stays put'],
];

const LINES = {
  hello: ['Ready when you are!', 'Let\'s map some roads.', 'Helmet on? Let\'s go.'],
  tap: ['Hi!', 'Hehe.', 'Let\'s find some litter!', 'Ride safe today.'],
  ride: 'Off we go!',
  stop: 'Nice ride!',
  joint: 'Little crack there.',
  rough: 'Bumpy bit!',
  bump: 'Oof! Pothole saved.',
  smog: 'The air is smoky here.',
  litter: 'Litter spotted!',
};

const SCOOTER = `<svg class="chibi-scooter" viewBox="0 0 120 40" aria-hidden="true">
  <g transform="matrix(-1 0 0 1 120 0)">
    <rect x="14" y="22" width="78" height="6" rx="3" fill="#2B2F2D"/>
    <line x1="88" y1="25" x2="100" y2="2" stroke="#2B2F2D" stroke-width="5" stroke-linecap="round"/>
    <line x1="92" y1="3" x2="110" y2="3" stroke="#2B2F2D" stroke-width="5" stroke-linecap="round"/>
    <g class="cs-wheel" style="transform-origin:22px 31px"><circle cx="22" cy="31" r="8" fill="#1B1D1C"/><line x1="16" y1="31" x2="28" y2="31" stroke="#8F948F" stroke-width="2"/></g>
    <g class="cs-wheel" style="transform-origin:90px 31px"><circle cx="90" cy="31" r="8" fill="#1B1D1C"/><line x1="84" y1="31" x2="96" y2="31" stroke="#8F948F" stroke-width="2"/></g>
  </g>
</svg>`;

let list = [];
let pref = null;
let stage = null;
let riding = false;
let smoggy = false;
let sayTimer;

const pick = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v);
const current = () => list.find((c) => c.id === pref?.chibi) || list[0];
const img = (c, cls = '') => `<img class="${cls}" src="/img/chibi/${esc(c.file)}" alt="" onerror="this.onerror=null;this.src='/img/chibi/placeholder.svg';this.classList.add('ph')" />`;

async function loadList() {
  if (!list.length) list = await fetch('/img/chibi/chibis.json').then((r) => r.json()).catch(() => []);
  return list;
}

function readPref() {
  const fromAccount = isMember() ? getUser()?.prefs || {} : {};
  let local = {};
  try { local = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
  return {
    chibi: fromAccount.chibi || local.chibi || list[0]?.id,
    motion: fromAccount.motion || local.motion || (reduced ? 'still' : 'bounce'),
  };
}

/** The chosen chibi's image, for other places that show it (the map's "you are here"). */
export const chibiSrc = () => (current() ? `/img/chibi/${current().file}` : '/img/chibi/placeholder.svg');

async function savePref(change) {
  pref = { ...pref, ...change };
  try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch {}
  window.dispatchEvent(new Event('chibi-changed'));
  if (!isMember()) return;
  try {
    const { user } = await api('/api/me/prefs', { method: 'PUT', body: change });
    if (user && getUser()) getUser().prefs = user.prefs;
  } catch (e) {
    toast(`Could not save to your account: ${e.message}`, 'err');
  }
}

function popIn(fig) {
  if (!fig) return;
  fig.classList.add('pop');
  fig.addEventListener('animationend', () => fig.classList.remove('pop'), { once: true });
}

function flash(cls, ms) {
  if (!stage) return;
  stage.classList.remove(cls);
  void stage.offsetWidth;
  stage.classList.add(cls);
  setTimeout(() => stage.classList.remove(cls), ms);
}

export function chibiSay(text) {
  const el = $('#chibi-say');
  const c = current();
  if (!el || !text || !c) return;
  el.textContent = `${c.name}: ${text}`;
  el.classList.add('show');
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

let shownId = null;

function renderHome() {
  const c = current();
  if (!stage || !c) return;
  const changed = shownId !== null && shownId !== c.id;
  shownId = c.id;
  stage.dataset.motion = pref.motion;
  stage.innerHTML = `<span class="chibi-fig">${img(c, 'chibi-img')}</span>${SCOOTER}<span class="chibi-shadow"></span>`;
  stage.setAttribute('aria-label', `${c.name}, your chibi. Tap to say hi.`);
  stage.classList.toggle('riding', riding);
  stage.classList.toggle('smog', smoggy);
  if (changed) popIn(stage.querySelector('.chibi-fig'));
}

export async function initChibi() {
  stage = $('#chibi');
  await loadList();
  pref = readPref();
  window.dispatchEvent(new Event('chibi-changed'));
  if (!stage) return;
  renderHome();
  stage.addEventListener('click', () => { flash('hop', 1150); chibiSay(pick(LINES.tap)); });
  setTimeout(() => { flash('hop', 1150); chibiSay(pick(LINES.hello)); }, 2700);
}

/** After sign-in or sign-out: the account may have its own chibi. */
export async function refreshChibi() {
  await loadList();
  pref = readPref();
  renderHome();
  window.dispatchEvent(new Event('chibi-changed'));
}

export function chibiRiding(on) {
  if (!stage || riding === on) return;
  riding = on;
  stage.classList.toggle('riding', on);
  chibiSay(on ? LINES.ride : LINES.stop);
  if (!on) { smoggy = false; stage.classList.remove('smog'); }
}

/** Faster pedalling at higher speed (km/h from the scooter's GPS). */
export function chibiSpeed(kmh) {
  if (!stage) return;
  if (!Number.isFinite(kmh)) return stage.style.removeProperty('--ride-dur');
  stage.style.setProperty('--ride-dur', `${Math.max(0.28, Math.min(1, 1.1 - kmh / 28)).toFixed(2)}s`);
}

export function chibiRoad(label) {
  if (!stage || !riding || !LINES[label]) return;
  if (label === 'bump' || label === 'rough') flash('jolt', 1000);
  chibiSay(LINES[label]);
}

export function chibiAir(pm, isBad = null) {
  if (!stage) return;
  const bad = isBad ?? (Number.isFinite(pm) && pm > 35);
  if (bad && !smoggy) chibiSay(LINES.smog);
  smoggy = bad;
  stage.classList.toggle('smog', bad);
}

export function chibiLitter() {
  flash('hop', 1150);
  chibiSay(LINES.litter);
}

// ---------------------------------------------------------------- profile page picker

export async function renderChibiPicker() {
  const box = $('#chibi-picker');
  if (!box) return;
  await loadList();
  pref = readPref();
  const draw = () => {
    box.innerHTML = `
      <div class="cp-preview chibi-stage" data-motion="${pref.motion}"><span class="chibi-fig">${img(current(), 'chibi-img')}</span><span class="chibi-shadow"></span></div>
      <div class="cp-grid" role="radiogroup" aria-label="Choose your chibi">
        ${list.map((c) => `<button type="button" class="cp-option ${c.id === pref.chibi ? 'on' : ''}" role="radio" aria-checked="${c.id === pref.chibi}" data-id="${esc(c.id)}">
          ${img(c, 'cp-img')}<span>${esc(c.name)}</span></button>`).join('')}
      </div>
      <div class="cp-label" id="cp-motion-label">Animation on your home page</div>
      <div class="cp-motions" role="radiogroup" aria-labelledby="cp-motion-label">
        ${MOTIONS.map(([id, name, hint]) => `<button type="button" class="${id === pref.motion ? 'on' : ''}" role="radio" aria-checked="${id === pref.motion}" data-motion="${id}" title="${esc(hint)}">${esc(name)}</button>`).join('')}
      </div>
      <p class="secondary small">${isMember() ? 'Saved to your account.' : 'Saved on this device. Sign in to keep it everywhere.'}
        Characters made with <a href="https://www.avatarsinpixels.com/" target="_blank" rel="noopener">Avatars In Pixels</a>.</p>`;
    box.querySelectorAll('.cp-option').forEach((b) => (b.onclick = async () => {
      await savePref({ chibi: b.dataset.id });
      draw();
      popIn(box.querySelector('.cp-preview .chibi-fig'));
      renderHome();
    }));
    box.querySelectorAll('[data-motion]').forEach((b) => {
      if (!b.matches('button')) return;
      b.onclick = async () => {
        await savePref({ motion: b.dataset.motion });
        draw();
        renderHome();
      };
    });
  };
  draw();
  stagger(box.querySelector('.cp-grid'));
}
