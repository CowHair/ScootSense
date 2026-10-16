// Road-surface classifiers: a transparent rule-based baseline and a trainable
// Gaussian Naive Bayes model. Both run in the browser and on the server.
import { CLASSES } from './signal.js';

export const FEATURE_KEYS = ['std', 'maxDev', 'p2p', 'jerk', 'kurtosis', 'domFreq', 'hfRatio'];
const LOG_KEYS = new Set(['std', 'maxDev', 'p2p', 'jerk', 'kurtosis']);

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Threshold baseline: explainable, works with zero training data. */
export function ruleClassify(f) {
  const bumpness = sigmoid((f.maxDev - 0.8) / 0.12);
  // Sustained vibration is spread out (low kurtosis); a single seam is spiky.
  const roughness = sigmoid((f.std - 0.085) / 0.02) * sigmoid((6 - f.kurtosis) / 1);
  const jointness = sigmoid((f.maxDev - 0.24) / 0.05) * sigmoid((f.kurtosis - 5) / 1.2);
  const raw = {
    bump: bumpness,
    rough: roughness * (1 - bumpness),
    joint: jointness * (1 - bumpness) * (1 - roughness),
  };
  raw.smooth = Math.max(0.02, 1 - Math.max(raw.bump, raw.rough, raw.joint));
  const probs = normalize(raw);
  const label = argmax(probs);
  return { label, confidence: probs[label], probs, model: 'rules', reasons: ruleReasons(f, label) };
}

function ruleReasons(f, label) {
  const r = [];
  if (label === 'bump') r.push(`Peak impact ${f.maxDev.toFixed(2)} g exceeds the 0.8 g bump threshold`);
  if (label === 'rough') r.push(`Sustained vibration ${f.std.toFixed(3)} g exceeds the 0.085 g roughness threshold`);
  if (label === 'joint') r.push(`Short spike (${f.maxDev.toFixed(2)} g) with high kurtosis ${f.kurtosis.toFixed(1)} looks like a seam`);
  if (label === 'smooth') r.push(`Vibration ${f.std.toFixed(3)} g and peak ${f.maxDev.toFixed(2)} g are within normal riding range`);
  return r;
}

export function toVector(f) {
  return FEATURE_KEYS.map((k) => (LOG_KEYS.has(k) ? Math.log1p(Math.max(0, f[k] ?? 0)) : f[k] ?? 0));
}

/** samples: [{label, features}] */
export function trainGNB(samples) {
  const stats = {};
  const classes = CLASSES.filter((c) => samples.some((s) => s.label === c));
  for (const c of classes) {
    const rows = samples.filter((s) => s.label === c).map((s) => toVector(s.features));
    const d = FEATURE_KEYS.length;
    const mean = Array(d).fill(0), variance = Array(d).fill(0);
    rows.forEach((r) => r.forEach((v, i) => (mean[i] += v / rows.length)));
    rows.forEach((r) => r.forEach((v, i) => (variance[i] += (v - mean[i]) ** 2 / rows.length)));
    stats[c] = { prior: rows.length / samples.length, mean, variance: variance.map((v) => v + 1e-3), n: rows.length };
  }
  return { type: 'gnb', classes, features: FEATURE_KEYS, stats, trainedAt: new Date().toISOString(), n: samples.length };
}

export function predictGNB(model, f) {
  const x = toVector(f);
  const logp = {};
  for (const c of model.classes) {
    const s = model.stats[c];
    let lp = Math.log(s.prior);
    x.forEach((v, i) => {
      lp += -0.5 * Math.log(2 * Math.PI * s.variance[i]) - ((v - s.mean[i]) ** 2) / (2 * s.variance[i]);
    });
    logp[c] = lp;
  }
  const max = Math.max(...Object.values(logp));
  const probs = normalize(Object.fromEntries(Object.entries(logp).map(([c, v]) => [c, Math.exp(v - max)])));
  const label = argmax(probs);
  return { label, confidence: probs[label], probs, model: 'gnb' };
}

/** Use the trained model when one exists, otherwise the rule baseline. */
export function classify(f, model) {
  if (model && model.type === 'gnb' && model.classes?.length >= 2) {
    const out = predictGNB(model, f);
    out.reasons = ruleClassify(f).reasons;
    return out;
  }
  return ruleClassify(f);
}

/**
 * Honest evaluation: hold out whole recordings when possible so neighbouring
 * windows from the same pass never leak between train and test.
 */
export function evaluate(samples) {
  const recs = [...new Set(samples.map((s) => s.recordingId))];
  let method, folds;
  if (recs.length >= 3) {
    method = `leave-one-recording-out (${recs.length} recordings)`;
    folds = recs.map((r) => ({ test: samples.filter((s) => s.recordingId === r), train: samples.filter((s) => s.recordingId !== r) }));
  } else {
    method = 'random 70/30 split (record more sessions for a stricter test)';
    const shuffled = [...samples].sort(() => Math.random() - 0.5);
    const cut = Math.floor(shuffled.length * 0.7);
    folds = [{ train: shuffled.slice(0, cut), test: shuffled.slice(cut) }];
  }
  const confusion = Object.fromEntries(CLASSES.map((a) => [a, Object.fromEntries(CLASSES.map((b) => [b, 0]))]));
  const ruleConfusion = structuredClone(confusion);
  let correct = 0, ruleCorrect = 0, total = 0;
  for (const { train, test } of folds) {
    if (!train.length || !test.length) continue;
    const m = trainGNB(train);
    for (const s of test) {
      const p = predictGNB(m, s.features).label;
      const r = ruleClassify(s.features).label;
      confusion[s.label][p]++;
      ruleConfusion[s.label][r]++;
      if (p === s.label) correct++;
      if (r === s.label) ruleCorrect++;
      total++;
    }
  }
  return {
    method, total,
    accuracy: total ? correct / total : 0,
    ruleAccuracy: total ? ruleCorrect / total : 0,
    confusion, ruleConfusion,
  };
}

function normalize(o) {
  const sum = Object.values(o).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / sum]));
}
function argmax(o) {
  return Object.entries(o).sort((a, b) => b[1] - a[1])[0][0];
}
