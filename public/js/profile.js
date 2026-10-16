// The rider's own numbers, read from Tiger Data (weekly buckets via TimescaleDB).
import { $, api, esc } from './ui.js';
import { getUser } from './auth.js';

let chart;

export function initProfile() {
  chart = new Chart($('#profile-chart'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'km ridden', data: [], backgroundColor: '#26A69A', yAxisID: 'y' },
      { label: 'litter picked up', data: [], backgroundColor: '#FF4081', yAxisID: 'y1' },
    ] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } },
      scales: { y: { beginAtZero: true, ticks: { maxTicksLimit: 4 } }, y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { maxTicksLimit: 4 } } },
    },
  });
}

export async function onShowProfile() {
  const u = getUser();
  $('#profile-name').textContent = u.guest ? 'Guest' : u.name;
  $('#profile-email').textContent = u.guest ? 'Not signed in' : u.email || 'Google account';
  $('#guest-cta').classList.toggle('hidden', !u.guest);
  const tiles = $('#profile-stats');
  if (u.guest) {
    tiles.innerHTML = '';
    $('#profile-db').textContent = '';
    return;
  }
  tiles.innerHTML = Array.from({ length: 6 }, () => '<div><span class="skel skel-line w60" style="height:24px"></span><span class="skel skel-line w40" style="margin-top:6px"></span></div>').join('');
  const [me, cfg] = await Promise.all([api('/api/me'), api('/api/auth/config')]);
  const t = me.activity.totals;
  const items = [
    [t.ride_km.toFixed(1), 'km ridden'], [t.pickup, 'litter picked up'], [t.litter_report, 'litter reported'],
    [t.hazard_hits, 'hazards detected'], [t.project, 'projects saved'], [t.vote, 'hazard votes'],
  ];
  tiles.innerHTML = items.map(([v, l]) => `<div class="fade-in"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  const db = cfg.database;
  $('#profile-db').textContent = db.backend === 'tiger' ? `Tiger Data${db.timescale ? ` · TimescaleDB ${db.timescale}` : ''}` : 'Local demo storage';

  const weeks = me.activity.weeks;
  chart.data.labels = weeks.map((w) => new Date(w.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  chart.data.datasets[0].data = weeks.map((w) => +w.km.toFixed(2));
  chart.data.datasets[1].data = weeks.map((w) => w.pickups);
  chart.update();
}
