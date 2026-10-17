import { $, api, toast, esc } from './ui.js';
import { getUser } from './auth.js';
import { openDialog, closeDialog, isDialogOpen, buzz, ago, realPosition } from './scan.js';
import { currentPosition } from './geo.js';
import { haversine } from '/shared/signal.js';

const RADIUS_M = 40;
const ASK_AGAIN_MS = 6 * 3600_000;
const KEY = 'scootsense.asked';

let litter = [];
let fetchedAt = 0;

const asked = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const markAsked = (no) => { try { const a = asked(); a[no] = Date.now(); localStorage.setItem(KEY, JSON.stringify(a)); } catch {} };

export function initLitterWatch() {
  $('#btn-sim-pass').addEventListener('click', simulatePass);
  window.addEventListener('data-changed', () => (fetchedAt = 0));
  setInterval(() => { if (!document.hidden) check(); }, 8000);
}

async function refresh() {
  if (Date.now() - fetchedAt < 60_000) return;
  fetchedAt = Date.now();
  litter = await api('/api/litter').catch(() => litter);
}

const mine = (l) => { const u = getUser(); return !!u?.id && l.reporterId === u.id; };

async function check() {
  if (isDialogOpen() || !getUser()) return;
  const p = realPosition();
  if (!p) return;
  await refresh();
  const a = asked();
  const hit = litter
    .filter((l) => !mine(l) && !(Date.now() - (a[l.no] || 0) < ASK_AGAIN_MS))
    .map((l) => ({ l, d: haversine(p, l) }))
    .filter((x) => x.d <= RADIUS_M)
    .sort((x, y) => x.d - y.d)[0];
  if (hit) askStillThere(hit.l.no, hit.d);
}

async function simulatePass() {
  fetchedAt = 0;
  await refresh();
  const p = realPosition() || currentPosition();
  const near = litter.filter((l) => !mine(l)).map((l) => ({ l, d: haversine(p, l) })).sort((x, y) => x.d - y.d)[0];
  if (!near) return toast('No litter from other riders on the map yet');
  askStillThere(near.l.no, near.d);
}

async function askStillThere(no, distance) {
  markAsked(no);
  let l;
  try { l = await api(`/api/litter/${no}`); } catch { return; }
  if (l.status !== 'reported' || isDialogOpen()) return;
  buzz();
  const dlg = openDialog(`
    ${l.photo ? `<img class="photo" src="${l.photo}" alt="Reported litter" />` : ''}
    <div class="dialog-body">
      <h2>Is this litter still here?</h2>
      <div>${esc(l.summary || l.items.map((i) => i.name).join(', '))}</div>
      <ul class="items">${l.items.map((i) => `<li>${esc(i.name)}${i.material ? ` (${esc(i.material)})` : ''}</li>`).join('')}</ul>
      <div class="secondary small">L${l.no} · about ${Math.round(distance)} m away · reported ${ago(l.at)}${l.lastSeen && l.lastSeen !== l.at ? ` · last seen ${ago(l.lastSeen)}` : ''}</div>
      <div class="notice">Only answer once you've stopped and had a look.</div>
    </div>
    <div class="dialog-actions stacked">
      <button class="btn flat accent-text" data-a="picked">I picked it up</button>
      <button class="btn flat" data-a="still">Yes, still here</button>
      <button class="btn flat" data-a="gone">No, it's gone</button>
      <button class="btn flat" data-a="later">Not sure</button>
    </div>`);
  dlg.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const answer = b.dataset.a;
    if (answer === 'later') return closeDialog();
    dlg.querySelectorAll('[data-a]').forEach((x) => (x.disabled = true));
    try {
      const r = await api(`/api/litter/${no}/check`, { method: 'POST', body: { answer } });
      closeDialog();
      const cleared = r.status === 'cleared';
      toast(answer === 'picked' ? 'Thanks for cleaning up! It has been taken off the map.'
        : answer === 'still' ? 'Thanks, the pin stays on the map.'
          : cleared ? 'Thanks, the pin has been removed.' : "Thanks. One more 'gone' answer removes the pin.", 'ok');
      fetchedAt = 0;
      window.dispatchEvent(new Event('data-changed'));
      if (answer === 'picked') window.dispatchEvent(new Event('trash-changed'));
    } catch (e) {
      toast(e.message, 'err');
      closeDialog();
    }
  }));
}
