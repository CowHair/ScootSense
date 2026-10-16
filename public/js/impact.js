import { $, api, toast, esc, ic, skeletonRows, classColor, classLabel, fmtDate, scoreColor } from './ui.js';
import { CLASSES } from '/shared/signal.js';

let funnel, mix;

export function initImpact() {
  funnel = new Chart($('#funnel-chart'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: ['#B0BEC5', '#80CBC4', '#26A69A', '#00897B', '#004D40'], borderRadius: 0 }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 4 } } } },
  });
  mix = new Chart($('#mix-chart'), {
    type: 'doughnut',
    data: { labels: CLASSES.map(classLabel), datasets: [{ data: [], backgroundColor: CLASSES.map(classColor), borderWidth: 0 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 10 } } } },
  });
  $('#ride-table').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !confirm('Delete this ride and every observation from it? Hazards are recomputed.')) return;
    await api(`/api/rides/${b.dataset.del}`, { method: 'DELETE' });
    toast('Ride deleted', 'ok');
    window.dispatchEvent(new Event('data-changed'));
    onShowImpact();
  });
}

export async function onShowImpact() {
  if (!$('#impact-kpis').children.length) {
    $('#impact-kpis').innerHTML = Array.from({ length: 6 }, () => '<div><span class="skel skel-line w60" style="height:24px"></span><span class="skel skel-line w80" style="margin-top:6px"></span></div>').join('');
    $('#ride-table').innerHTML = skeletonRows(3);
  }
  const [s, rides] = await Promise.all([api('/api/stats'), api('/api/rides')]);
  const tiles = [
    [s.distanceKm, 'km surveyed', `${s.rides} rides`],
    [s.hazards, 'road hazards', `${s.repeatedHazards} seen on 2+ rides`],
    [s.itemsPickedUp, 'litter items picked up', `${s.litterCleared} reports cleaned`],
    [s.litterOnMap, 'litter spots mapped', 'waiting for pickup'],
    [s.avgPm25 ?? '—', 'avg PM2.5 µg/m³', `${s.pollutionHotspots} pollution hotspots`],
    [s.upcycleIdeas, 'project ideas', 'suggested by Gemini'],
    [s.confirmed, 'hazards confirmed', `${s.photosAnalyzed} photos checked`],
    [s.verificationPrecision === null ? '—' : `${Math.round(s.verificationPrecision * 100)}%`, 'verification precision', 'confirmed ÷ decided'],
  ];
  $('#impact-kpis').innerHTML = tiles.map(([v, l, sub]) => `<div class="fade-in"><b>${v}</b><span>${l}</span><em>${sub}</em></div>`).join('');

  funnel.data.labels = ['Bumpy windows', 'Hazard spots', 'Seen 2+ rides', 'Confirmed', 'Fixed'];
  funnel.data.datasets[0].data = [(s.labelCounts.rough || 0) + (s.labelCounts.bump || 0), s.hazards, s.repeatedHazards, s.confirmed, s.fixed];
  funnel.update();
  mix.data.datasets[0].data = CLASSES.map((c) => s.labelCounts[c] || 0);
  mix.update();

  $('#ride-table').innerHTML = rides.map((r) => `<li>
      <span class="avatar" style="background:${scoreColor(r.avgScore * 1.6)}">${ic('directions_bike')}</span>
      <div class="lines"><b>${esc(r.name)}</b><span>${fmtDate(r.startedAt)} · ${(r.distanceM / 1000).toFixed(2)} km · ${r.hazardHits} hazards</span></div>
      <button class="icon-btn dark" data-del="${r.id}" aria-label="Delete ride">${ic('delete')}</button>
    </li>`).join('') || '<li class="empty">No rides yet.</li>';
}
