import { $, api, toast, md, esc, ic } from './ui.js';
import { getUser, isMember } from './auth.js';
import { getStash, saveProject } from './stash.js';
import { shrinkDataUrl } from './scan.js';

const history = [];
let opener = null;
let speakAll = false;
let greeted = false;

const CHIPS = [
  ['What can I make from my trash?', 'construction'],
  ['How much CO₂ have I saved?', 'eco'],
  ['Plan a cleanup ride near me', 'route'],
  ['Report the worst pothole to 311', 'campaign'],
  ['Is the air OK for a ride?', 'air'],
  ['Give me a 7-day eco plan', 'event_available'],
];

export function initCoach() {
  $('#coach-fab').addEventListener('click', () => openCoach());
  $('#dock-gemini').addEventListener('click', () => openCoach());
  $('#open-coach')?.addEventListener('click', (e) => { e.preventDefault(); openCoach(); });
  $('#coach-close').addEventListener('click', closeCoach);
  $('#coach-scrim').addEventListener('click', closeCoach);
  $('#coach').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCoach(); });
  $('#coach-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#coach-q').value.trim();
    if (q) ask(q);
  });
  $('#coach-chips').innerHTML = CHIPS.map(([t, i]) => `<button type="button" class="coach-chip">${ic(i)}<span>${esc(t)}</span></button>`).join('');
  $('#coach-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.coach-chip');
    if (b) ask(b.querySelector('span').textContent);
  });
  $('#coach-speak').addEventListener('click', () => {
    speakAll = !speakAll;
    $('#coach-speak').setAttribute('aria-pressed', String(speakAll));
    $('#coach-speak i').textContent = speakAll ? 'volume_up' : 'volume_off';
    if (!speakAll) speechSynthesis?.cancel();
    toast(speakAll ? 'Answers will be read aloud' : 'Read-aloud off');
  });
  setupVoice();
}

export function openCoach(prompt) {
  opener = document.activeElement;
  $('#coach').classList.remove('hidden');
  $('#coach-scrim').classList.remove('hidden');
  document.body.classList.add('coach-open');
  if (!greeted) {
    greeted = true;
    const name = getUser()?.guest ? '' : ` ${String(getUser()?.name || '').split(' ')[0]}`;
    addMsg('ai', `<div class="markdown"><p>Hi${esc(name)}! I'm your eco coach.</p><p>I can turn litter you've picked up into something useful, plan a cleanup ride, work out your carbon savings, or write a report to the city. What would you like to do?</p></div>`);
  }
  setTimeout(() => (prompt ? ask(prompt) : $('#coach-q').focus()), 60);
}

function closeCoach() {
  $('#coach').classList.add('hidden');
  $('#coach-scrim').classList.add('hidden');
  document.body.classList.remove('coach-open');
  speechSynthesis?.cancel();
  opener?.focus?.();
}

async function ask(q) {
  $('#coach-q').value = '';
  addMsg('user', esc(q));
  const pending = addMsg('ai', '<div class="typing" aria-label="Gemini is thinking"><i></i><i></i><i></i></div>');
  try {
    const r = await api('/api/ai/chat', { method: 'POST', body: { message: q, history, stash: isMember() ? [] : getStash() } });
    pending.innerHTML = `<div class="markdown">${md(r.text || '')}</div>`;
    for (const card of r.cards || []) pending.after(renderCard(card));
    addSpeakButton(pending, r.text);
    history.push({ role: 'user', text: q }, { role: 'model', text: r.text || '' });
    if (speakAll) speak(r.text);
  } catch (e) {
    pending.innerHTML = `<p>Sorry, something went wrong: ${esc(e.message)}</p>`;
  }
  scrollLog();
}

function addMsg(role, html) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.innerHTML = html;
  $('#coach-log').append(el);
  scrollLog();
  return el;
}

const scrollLog = () => requestAnimationFrame(() => ($('#coach-log').scrollTop = 1e9));

function renderCard(card) {
  const el = document.createElement('div');
  el.className = `coach-card ${card.type}`;
  if (card.type === 'project') projectCard(el, card.idea, card.from);
  if (card.type === 'route') {
    el.innerHTML = `<div class="cc-head">${ic('route')}<b>Cleanup ride · about ${card.km} km</b></div>
      <ol class="cc-stops">${card.stops.map((s) => `<li><b>${esc(s.id)}</b> ${esc(s.items.join(', '))} <span>${s.metresFromLast} m</span></li>`).join('')}</ol>
      <div class="cc-actions"><a class="btn raised accent" href="${esc(card.url)}" target="_blank" rel="noopener">${ic('directions')} Open in Google Maps</a>
        <a class="btn flat" href="#map">See on map</a></div>
      <p class="secondary small">Bring gloves and a bag. Anything sharp or hazardous: leave it and report it instead.</p>`;
  }
  if (card.type === 'report') {
    el.innerHTML = `<div class="cc-head">${ic('campaign')}<b>${esc(card.subject)}</b></div>
      <pre class="cc-report" tabindex="0">${esc(card.body)}</pre>
      <div class="cc-actions"><button class="btn raised accent" data-copy>${ic('content_copy')} Copy report</button>
        <a class="btn flat" href="${esc(card.link)}" target="_blank" rel="noopener">Open Toronto 311</a></div>`;
    el.querySelector('[data-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(`${card.subject}\n\n${card.body}`); toast('Report copied. Paste it into the 311 form.', 'ok'); }
      catch { toast('Copy failed: select the text and copy it instead', 'err'); }
    };
  }
  return el;
}

export function projectCard(el, idea, from = []) {
  const uses = [...(idea.usesFromHome || []), ...(idea.extraNeeded || []).map((x) => `${x} (extra)`)];
  el.innerHTML = `
    <div class="cc-visual" data-visual></div>
    <div class="cc-body">
      <h3>${esc(idea.title)}</h3>
      <p>${esc(idea.pitch)}</p>
      ${from.length ? `<p class="secondary small">Made from litter you picked up: ${esc(from.join(', '))}</p>` : ''}
      ${uses.length ? `<div class="cc-uses">${uses.map((u) => `<span>${esc(u)}</span>`).join('')}</div>` : ''}
      <ol class="cc-steps">${(idea.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <p class="secondary small">About ${idea.minutes || '?'} min · ${esc(idea.difficulty || 'easy')}${idea.safety ? ` · ${esc(idea.safety)}` : ''}</p>
      <div class="cc-actions"><button class="btn raised primary" data-save>${ic('bookmark_add')} Save to my projects</button></div>
    </div>`;
  let image = null;
  const draw = async () => {
    const vis = el.querySelector('[data-visual]');
    vis.innerHTML = '<div class="cc-drawing" role="status"><span class="skel"></span><p>Drawing your project…</p></div>';
    try {
      const r = await api('/api/ai/project-image', { method: 'POST', body: { idea } });
      if (r.error) throw new Error(r.error);
      image = r.image;
      vis.innerHTML = `<img src="${r.image}" alt="AI-generated picture of the finished ${esc(idea.title)}" class="cc-img" />
        <span class="cc-badge">${ic('auto_awesome')} AI-generated${r.model ? ` · ${esc(r.model)}` : ''}</span>`;
      vis.querySelector('img').addEventListener('load', scrollLog, { once: true });
    } catch (e) {
      vis.innerHTML = `<div class="cc-placeholder">${ic('hide_image')}<span>${esc(e.message)}</span>
        <button class="btn raised accent" data-retry>${ic('refresh')} Try again</button></div>`;
      vis.querySelector('[data-retry]').onclick = draw;
    }
  };
  draw();
  el.querySelector('[data-save]').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const saved = await saveProject({ ...idea }, from.length ? `From litter you picked up: ${from.join(', ')}` : 'Suggested by Gemini');
      if (image && saved?.id && isMember()) {
        const small = await shrinkDataUrl(image, 640);
        await api(`/api/me/projects/${saved.id}/image`, { method: 'PUT', body: { image: small } });
        window.dispatchEvent(new Event('trash-changed'));
      }
      btn.innerHTML = `${ic('bookmark_added')} Saved`;
      toast('Saved to your projects on the Me tab', 'ok');
    } catch (e) {
      btn.disabled = false;
      toast(e.message, 'err');
    }
  };
}

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('#coach-mic').classList.add('hidden'); return; }
  const rec = new SR();
  rec.lang = navigator.language || 'en-CA';
  rec.interimResults = true;
  let listening = false;
  rec.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join('');
    $('#coach-q').value = text;
    if (e.results[e.results.length - 1].isFinal) { rec.stop(); ask(text); }
  };
  rec.onend = () => { listening = false; $('#coach-mic').classList.remove('listening'); };
  rec.onerror = () => toast('Could not hear that. Check microphone permission.', 'err');
  $('#coach-mic').addEventListener('click', () => {
    if (listening) return rec.stop();
    listening = true;
    $('#coach-mic').classList.add('listening');
    rec.start();
  });
}

function addSpeakButton(bubble, text) {
  if (!('speechSynthesis' in window) || !text) return;
  const b = document.createElement('button');
  b.className = 'bubble-speak';
  b.type = 'button';
  b.setAttribute('aria-label', 'Read this answer aloud');
  b.innerHTML = ic('volume_up');
  b.onclick = () => speak(text);
  bubble.append(b);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const plain = String(text).replace(/[*_#>`|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1');
  const u = new SpeechSynthesisUtterance(plain);
  u.lang = navigator.language || 'en-CA';
  u.rate = 1;
  speechSynthesis.speak(u);
}
