import { sensor } from './sensor.js';
import { $, api, toast, esc, classColor, classLabel } from './ui.js';
import { CLASSES, extractFeatures } from '/shared/signal.js';
import { trainGNB, evaluate } from '/shared/classifier.js';
import { syntheticTrainingSet } from '/shared/simulator.js';

const HINTS = { smooth: 'flat pavement', joint: 'sidewalk seam', rough: 'gravel / broken', bump: 'curb drop, bump' };
let label = 'smooth';
let recording = null;
let samples = [];
let candidate = null;
let chart;

export function initTrain() {
  $('#label-picker').innerHTML = CLASSES.map((c) =>
    `<button data-label="${c}" style="color:${classColor(c)}" class="${c === label ? 'on' : ''}">${classLabel(c)}<small>${HINTS[c]}</small></button>`).join('');
  $('#label-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || recording) return;
    label = b.dataset.label;
    $('#label-picker').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#btn-rec').addEventListener('click', toggleRecording);
  $('#btn-synth').addEventListener('click', loadSynthetic);
  $('#btn-clear-train').addEventListener('click', async () => {
    if (!confirm('Delete all labelled training windows?')) return;
    await api('/api/training', { method: 'DELETE' });
    refresh();
  });
  $('#btn-train').addEventListener('click', train);
  $('#btn-deploy').addEventListener('click', deploy);
  $('#btn-undeploy').addEventListener('click', async () => {
    await api('/api/model', { method: 'DELETE' });
    sensor.model = null;
    showDeployed();
    toast('Live pipeline now uses the rule-based baseline.', 'ok');
  });

  sensor.addEventListener('window', (e) => {
    if (!recording) return;
    recording.buffer.push({ label: recording.label, recordingId: recording.id, features: e.detail.features, source: sensor.kind });
    recording.count++;
    $('#rec-status').textContent = `Recording “${classLabel(recording.label)}” · ${recording.count} windows`;
    if (recording.buffer.length >= 10) flushRec();
  });
  sensor.addEventListener('state', () => {
    $('#train-source').textContent = sensor.kind ? `Source: ${sensor.kind}` : 'Connect a source on Live ride first';
    if (!sensor.kind && recording) toggleRecording();
  });

  chart = new Chart($('#feature-chart'), {
    type: 'scatter',
    data: { datasets: CLASSES.map((c) => ({ label: classLabel(c), data: [], backgroundColor: classColor(c), pointRadius: 3 })) },
    options: {
      animation: false, maintainAspectRatio: false,
      scales: {
        x: { type: 'logarithmic', title: { display: true, text: 'vibration std (g)' } },
        y: { type: 'logarithmic', title: { display: true, text: 'peak deviation (g)' } },
      },
    },
  });
}

export async function onShowTrain() {
  await refresh();
  showDeployed();
}

async function refresh() {
  samples = await api('/api/training');
  const recs = new Set(samples.map((s) => s.recordingId));
  const by = Object.fromEntries(CLASSES.map((c) => [c, samples.filter((s) => s.label === c)]));
  $('#train-counts').innerHTML = `<tr><th>Label</th><th class="num">Windows</th><th class="num">Recordings</th></tr>` +
    CLASSES.map((c) => `<tr><td><span class="dot" style="display:inline-block;background:${classColor(c)}"></span> ${classLabel(c)}</td>
      <td class="num">${by[c].length}</td><td class="num">${new Set(by[c].map((s) => s.recordingId)).size}</td></tr>`).join('') +
    `<tr><td><b>Total</b></td><td class="num"><b>${samples.length}</b></td><td class="num"><b>${recs.size}</b></td></tr>`;
  chart.data.datasets.forEach((d, i) => {
    d.data = by[CLASSES[i]].map((s) => ({ x: Math.max(0.003, s.features.std), y: Math.max(0.01, s.features.maxDev) }));
  });
  chart.update();
}

function toggleRecording() {
  if (recording) {
    flushRec().then(refresh);
    toast(`Saved ${recording.count} “${classLabel(recording.label)}” windows`, 'ok');
    recording = null;
    $('#btn-rec').textContent = 'Record';
    $('#btn-rec').classList.replace('stop', 'accent');
    $('#rec-status').textContent = '';
    return;
  }
  if (!sensor.running) return toast('Start a source on the Live ride page first (simulator works too).', 'err');
  if (sensor.serverSide) return toast('Training uses USB serial or the simulator.', 'err');
  recording = { id: `rec-${Date.now().toString(36)}`, label, buffer: [], count: 0 };
  $('#btn-rec').textContent = 'Stop';
  $('#btn-rec').classList.replace('accent', 'stop');
}

async function flushRec() {
  if (!recording?.buffer.length) return;
  const batch = recording.buffer.splice(0);
  await api('/api/training', { method: 'POST', body: { samples: batch } });
}

async function loadSynthetic() {
  const set = syntheticTrainingSet({ perClass: 48, recordings: 4, seed: Math.floor(Math.random() * 1000) })
    .map((s) => ({ label: s.label, recordingId: s.recordingId, features: extractFeatures(s.samples), source: 'synthetic' }));
  await api('/api/training', { method: 'POST', body: { samples: set } });
  toast(`Added ${set.length} synthetic bench windows (clearly tagged as synthetic)`, 'ok');
  refresh();
}

function train() {
  const usable = samples.filter((s) => CLASSES.includes(s.label));
  const present = new Set(usable.map((s) => s.label));
  if (present.size < 2 || usable.length < 20) return toast('Need at least 20 windows across 2+ labels.', 'err');
  const ev = evaluate(usable);
  candidate = trainGNB(usable);
  candidate.metrics = { accuracy: ev.accuracy, ruleAccuracy: ev.ruleAccuracy, method: ev.method, testWindows: ev.total,
    synthetic: usable.some((s) => s.source === 'synthetic') };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const mat = (conf) => `<table class="tbl confusion"><tr><th>Actual \\ predicted</th>${CLASSES.map((c) => `<th>${classLabel(c)}</th>`).join('')}</tr>` +
    CLASSES.map((a) => `<tr><th>${classLabel(a)}</th>${CLASSES.map((b) => `<td class="${a === b ? 'diag' : ''}">${conf[a][b] || ''}</td>`).join('')}</tr>`).join('') + '</table>';
  $('#eval').innerHTML = `
    <div class="score">
      <div><b style="color:var(--primary)">${pct(ev.accuracy)}</b><span class="secondary small">trained model</span></div>
      <div><b>${pct(ev.ruleAccuracy)}</b><span class="secondary small">rule baseline</span></div>
      <div><b>${ev.total}</b><span class="secondary small">held-out windows</span></div>
    </div>
    <p class="secondary small">Method: ${esc(ev.method)}.${candidate.metrics.synthetic ? ' Includes synthetic data, so collect real recordings before quoting these numbers.' : ''}</p>
    <h4 class="mini-title">Trained model confusion matrix</h4>${mat(ev.confusion)}`;
  $('#btn-deploy').disabled = false;
}

async function deploy() {
  if (!candidate) return;
  await api('/api/model', { method: 'POST', body: candidate });
  sensor.model = candidate;
  showDeployed();
  toast('Model deployed. Live rides now use it.', 'ok');
}

function showDeployed() {
  const m = sensor.model;
  $('#deployed-tag').textContent = m ? `Deployed, ${Math.round((m.metrics?.accuracy || 0) * 100)}% held-out` : 'Using rules';
}
