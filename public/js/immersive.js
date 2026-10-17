import { $, $$ } from './ui.js';

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let hero, layers, front = 0, particles, haze = 0, wind = 0, crackTimer = null;

export function initHero() {
  hero = $('#road-photo');
  layers = $$('.ph-layer', hero);
  particles = new Particles($('.fx-particles', hero));
  setAir(null);
  if (!reduceMotion) {
    attachTilt(hero, $('.ph-stage', hero), 14);
    parallaxOnScroll();
  }
}

export function swapHeroPhoto(url) {
  const next = layers[1 - front];
  next.style.backgroundImage = `url(${url})`;
  next.classList.remove('show');
  void next.offsetWidth;
  next.classList.add('show');
  layers[front].classList.remove('show');
  front = 1 - front;
}

export function setAir(pm) {
  haze = pm === null ? 0 : Math.max(0, Math.min(0.8, (pm - 14) / 55));
  hero?.style.setProperty('--haze', haze.toFixed(2));
  particles?.setMode(haze > 0.25 ? 'dust' : 'leaves', haze);
}

export function setSpeed(kmh) {
  wind = Number.isFinite(kmh) ? Math.min(30, kmh) / 30 : 0;
  particles?.setWind(wind);
}

export function crack() {
  if (!hero || reduceMotion) return;
  hero.classList.remove('shake', 'cracked');
  void hero.offsetWidth;
  hero.classList.add('shake', 'cracked');
  clearTimeout(crackTimer);
  crackTimer = setTimeout(() => hero.classList.remove('cracked'), 2600);
}

class Particles {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'leaves';
    this.wind = 0;
    this.list = [];
    this.running = false;
    if (reduceMotion) return;
    new ResizeObserver(() => this.resize()).observe(canvas);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.kick(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => this.kick());
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.c.width = r.width * this.dpr; this.c.height = r.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fill();
  }
  setMode(mode, density) { this.mode = mode; this.density = density; this.fill(); }
  setWind(w) { this.wind = w; }
  fill() {
    if (!this.w) return;
    const n = this.mode === 'dust' ? Math.round(40 + this.density * 60) : 11;
    this.list = Array.from({ length: n }, () => this.spawn(true));
  }
  spawn(anywhere) {
    const leaf = this.mode === 'leaves';
    const hues = ['#8BC34A', '#AED581', '#D4E157', '#FFCA28', '#A1887F'];
    const depth = Math.random();
    const near = depth > 0.82, far = depth < 0.4;
    return {
      x: anywhere ? Math.random() * this.w : -20, y: Math.random() * this.h,
      vx: (leaf ? 0.25 + Math.random() * 0.4 : 0.1 + Math.random() * 0.25) * (near ? 2.2 : far ? 0.6 : 1),
      vy: leaf ? -0.1 + Math.random() * 0.35 : -0.05 + Math.random() * 0.1,
      r: leaf ? (near ? 7 + Math.random() * 3 : far ? 1.8 + Math.random() * 1.2 : 3 + Math.random() * 2) : 0.6 + Math.random() * 1.8,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.06, flip: Math.random() * 6.28,
      blur: leaf && near ? 2 : 0,
      a: leaf ? (near ? 0.45 : far ? 0.35 : 0.7) : 0.25 + Math.random() * 0.35,
      color: leaf ? hues[Math.floor(Math.random() * hues.length)] : '#D7CCC8',
      phase: Math.random() * 6.28,
    };
  }
  kick() {
    const should = this.visible && !document.hidden;
    if (should && !this.running) { this.running = true; requestAnimationFrame((t) => this.frame(t)); }
    if (!should) this.running = false;
  }
  frame(t) {
    if (!this.running) return;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const gust = 1 + this.wind * 4;
    for (const p of this.list) {
      p.phase += 0.02;
      p.x += p.vx * gust;
      p.y += p.vy + Math.sin(p.phase) * (this.mode === 'leaves' ? 0.35 : 0.08);
      p.rot += p.vr * gust;
      if (p.x > w + 20 || p.y < -20 || p.y > h + 20) Object.assign(p, this.spawn(false));
      ctx.globalAlpha = p.a;
      ctx.fillStyle = p.color;
      if (this.mode === 'leaves') {
        p.flip += 0.05;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, 0.35 + Math.abs(Math.sin(p.flip)) * 0.65);
        if (p.blur) ctx.filter = `blur(${p.blur}px)`;
        const L = p.r * 2;
        ctx.beginPath();
        ctx.moveTo(-L, 0);
        ctx.quadraticCurveTo(0, -p.r * 1.3, L, 0);
        ctx.quadraticCurveTo(0, p.r * 1.3, -L, 0);
        ctx.fill();
        ctx.globalAlpha = p.a * 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,.7)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(-L * 0.9, 0);
        ctx.lineTo(L * 0.9, 0);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame((tt) => this.frame(tt));
  }
}

export function attachTilt(el, layer, px = 12) {
  if (!el || reduceMotion) return;
  const set = (x, y) => {
    layer.style.setProperty('--tx', `${(-x * px).toFixed(1)}px`);
    layer.style.setProperty('--ty', `${(-y * px).toFixed(1)}px`);
    el.style.setProperty('--rx', `${(y * 3).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(-x * 3).toFixed(2)}deg`);
  };
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    set((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5);
  });
  el.addEventListener('pointerleave', () => set(0, 0));
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma === null) return;
    set(Math.max(-1, Math.min(1, e.gamma / 30)) / 2, Math.max(-1, Math.min(1, (e.beta - 45) / 30)) / 2);
  });
}

function parallaxOnScroll() {
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = Math.min(400, scrollY);
      document.documentElement.style.setProperty('--scroll', y.toFixed(0));
    });
  }, { passive: true });
}

const revealer = reduceMotion ? null : new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });

export function revealCards(view) {
  if (!revealer) return;
  $$('.card:not(.reveal)', view).forEach((card, i) => {
    card.classList.add('reveal');
    card.style.setProperty('--d', `${Math.min(i, 5) * 60}ms`);
    revealer.observe(card);
  });
}

const ORDER = ['ride', 'map', 'stash', 'scan', 'insights', 'impact', 'profile', 'device', 'train'];
let current = null;

export function transitionTo(view, swap) {
  const prev = current;
  current = view;
  if (!document.startViewTransition || reduceMotion || document.hidden || !prev || prev === view) return swap();
  document.documentElement.dataset.dir = ORDER.indexOf(view) >= ORDER.indexOf(prev) ? 'fwd' : 'back';
  const t = document.startViewTransition(swap);
  t.ready.catch(() => {});
  t.finished.catch(() => {});
}

export function initPhotoStack() {
  const stack = $('.photo-stack');
  if (!stack || reduceMotion) return;
  const imgs = $$('img', stack);
  let order = [0, 1, 2];
  const place = () => imgs.forEach((img, i) => (img.dataset.pos = order.indexOf(i)));
  place();
  setInterval(() => {
    if (document.hidden || $('#auth').classList.contains('hidden')) return;
    order = [order[2], order[0], order[1]];
    place();
  }, 3200);
  attachTilt(stack, stack, 6);
}
