const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The home screen's opening sequence, once per app start. */
export function playHomeIntro() {
  if (reduced() || !document.querySelector('[data-view="ride"].active')) return;
  document.body.classList.add('home-intro');
  setTimeout(() => document.body.classList.remove('home-intro'), 2600);
}

/** Children of `el` rise in one after another (lists, pickers). */
export function stagger(el, selector = ':scope > *', step = 40, max = 12) {
  if (!el || reduced()) return;
  el.querySelectorAll(selector).forEach((c, i) => {
    c.style.setProperty('--i', String(Math.min(i, max)));
    c.style.setProperty('--step', `${step}ms`);
    c.classList.remove('stagger-in');
    void c.offsetWidth;
    c.classList.add('stagger-in');
  });
}
