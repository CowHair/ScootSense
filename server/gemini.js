// All Gemini API calls live here. Every feature has a deterministic fallback so the
// demo keeps working when there is no key or the network drops.
import { GoogleGenAI, Type } from '@google/genai';
import * as store from './store.js';

const MODEL = 'gemini-flash-latest';
const ai = new GoogleGenAI({ apiKey: 'AQ.Ab8RN6KBWHLPxxTnNah5E9Ah3W5n5wkNsS6uty5qtX9MOezKVQ' });

export const geminiStatus = () => ({ enabled: !!ai, model: MODEL });

const SYSTEM = `You are ScootSense AI, the analyst behind a low-cost, scooter-mounted road-condition sensor
(ESP32 + MPU6050 accelerometer + GPS). Riders' vibration data is classified into smooth / crack-joint /
rough surface / pothole-bump windows and clustered into hazard locations. Your audience is city staff,
accessibility advocates and riders. Be concrete and honest: detections are vibration-based estimates,
not verified potholes, until a person confirms them or a photo supports them. Never invent data that
was not supplied by a tool or the prompt. Prefer short paragraphs and bullet lists.`;

const FALLBACK_MODEL = 'gemini-flash-lite-latest';
const busy = (e) => /(429|503)|quota|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded/i.test(String(e?.message || e));

export async function generate(params) {
  const req = { model: MODEL, ...params, config: { systemInstruction: SYSTEM, ...params.config } };
  try {
    return await ai.models.generateContent(req);
  } catch (e) {
    // Free-tier quota or a demand spike: retry once on the lighter model, which has its own quota.
    if (!busy(e) || params.model || req.model === FALLBACK_MODEL) throw e;
    return ai.models.generateContent({ ...req, model: FALLBACK_MODEL });
  }
}

const compactHazard = (h) => ({
  id: `H${h.no}`, type: h.typeLabel, severity: h.severity, maxScore: h.maxScore,
  independentRides: h.reports, detectionRate: h.detectionRate, status: h.status,
  confidence: h.confidence, priority: h.priority, lat: h.lat, lng: h.lng,
  lastSeen: h.lastSeen, photoFindings: h.photos.map((p) => p.analysis?.summary).filter(Boolean),
});

// ---------------------------------------------------------------- photo verification

const PHOTO_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    isRoadDefect: { type: Type.BOOLEAN, description: 'Does the photo show a pavement/path defect?' },
    defectType: { type: Type.STRING, enum: ['pothole', 'crack', 'uneven slab / trip edge', 'rough surface', 'debris', 'curb / ramp issue', 'none', 'unclear'] },
    severity: { type: Type.INTEGER, description: '1 (cosmetic) to 5 (dangerous)' },
    accessibilityImpact: { type: Type.STRING, description: 'Effect on wheelchairs, strollers, scooters and pedestrians' },
    recommendedAction: { type: Type.STRING },
    confidence: { type: Type.NUMBER, description: '0-1' },
    summary: { type: Type.STRING, description: 'One sentence a city worker can act on' },
    privacyConcern: { type: Type.BOOLEAN, description: 'Are faces or licence plates clearly visible?' },
  },
  required: ['isRoadDefect', 'defectType', 'severity', 'accessibilityImpact', 'recommendedAction', 'confidence', 'summary', 'privacyConcern'],
  propertyOrdering: ['isRoadDefect', 'defectType', 'severity', 'accessibilityImpact', 'recommendedAction', 'confidence', 'summary', 'privacyConcern'],
};

export async function analyzePhoto({ imageBase64, mimeType, hazard }) {
  const context = hazard ? `The sensor flagged this spot as "${hazard.typeLabel}" with severity ${hazard.severity}/100 across ${hazard.reports} independent ride(s).` : '';
  try {
    const res = await generate({
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { text: `${context}\nInspect this photo taken at the flagged location. Decide whether it shows a road or sidewalk defect that would explain a vibration spike, rate it, and describe the accessibility impact. Judge only from what is visible.` },
      ] }],
      config: { responseMimeType: 'application/json', responseSchema: PHOTO_SCHEMA, temperature: 0.2 },
    });
    return { ...JSON.parse(res.text), source: 'gemini', model: MODEL };
  } catch (e) {
    return {
      isRoadDefect: null, defectType: 'unclear', severity: null, confidence: 0,
      accessibilityImpact: 'Not assessed.', recommendedAction: 'Review the photo manually.',
      summary: 'Photo stored. Automatic analysis unavailable: ' + reason(e), privacyConcern: null,
      source: 'fallback', error: reason(e),
    };
  }
}

// ---------------------------------------------------------------- city report

export async function cityReport({ audience = 'city maintenance team', focus = '' } = {}) {
  const s = store.stats();
  const hazards = store.listHazards().slice(0, 25).map(compactHazard);
  const worst = store.roughnessGrid().sort((a, b) => b.score - a.score).slice(0, 8);
  const db = store.getDb();
  const payload = {
    stats: s, topHazards: hazards, roughestSegments: worst,
    pollutionHotspots: store.pollutionHotspots().slice(0, 6),
    litterReports: db.litter.filter((l) => l.status === 'reported').slice(-15).map((l) => ({ id: `L${l.no}`, items: l.items.map((i) => i.name), lat: l.lat, lng: l.lng })),
    generatedAt: new Date().toISOString(),
  };
  try {
    const res = await generate({
      contents: `Write a road-condition briefing for: ${audience}. ${focus ? 'Focus: ' + focus : ''}
Use this JSON data only:\n${JSON.stringify(payload)}

Structure (Markdown):
## Executive summary (3 bullets with numbers)
## Priority repair list (table: Rank | Hazard ID | Type | Evidence | Why it matters | Suggested action). Reference hazards as H<number>.
## Accessibility impact
## Air quality & litter (PM2.5 hotspots in µg/m³, litter reports as L<number>)
## Data quality & caveats (sample size, unverified share, GPS precision, what to collect next)
## Next 7 days (3 concrete actions)`,
      config: { temperature: 0.4 },
    });
    return { markdown: res.text, source: 'gemini', model: MODEL, data: payload };
  } catch (e) {
    return { markdown: fallbackReport(payload, e), source: 'fallback', error: reason(e), data: payload };
  }
}

function fallbackReport({ stats: s, topHazards }, e) {
  const rows = topHazards.slice(0, 8).map((h, i) =>
    `| ${i + 1} | ${h.id} | ${h.type} | ${h.independentRides} ride(s), severity ${h.severity} | ${h.status} | ${h.status === 'confirmed' ? 'Schedule repair' : 'Inspect on site'} |`).join('\n');
  return `> Offline report (Gemini unavailable: ${reason(e)}). Numbers below are computed locally.

## Executive summary
- **${s.distanceKm} km** surveyed across **${s.rides} rides**, producing **${s.observations.toLocaleString()} observations**.
- **${s.hazards} active hazard locations**, of which **${s.repeatedHazards}** were detected on more than one ride.
- **${s.confirmed}** confirmed by the community; verification precision ${s.verificationPrecision === null ? 'not yet measurable' : Math.round(s.verificationPrecision * 100) + '%'}.

## Priority repair list
| Rank | Hazard | Type | Evidence | Status | Action |
|---|---|---|---|---|---|
${rows || '| – | – | – | – | – | – |'}

## Data quality & caveats
- Detections are vibration-based estimates. Single-ride detections should be inspected before action.
- Retry when Gemini is available to generate a narrative briefing.`;
}

// ---------------------------------------------------------------- ride summary

export async function rideSummary(rideId) {
  const ride = store.getRide(rideId);
  if (!ride) return null;
  const obs = store.getDb().observations.filter((o) => o.rideId === rideId);
  const counts = {};
  obs.forEach((o) => (counts[o.label] = (counts[o.label] || 0) + 1));
  const hazards = store.listHazards().filter((h) => h.rideIds.includes(rideId)).slice(0, 10).map(compactHazard);
  const comfort = Math.max(0, 100 - ride.avgScore * 1.6);
  const data = { ride: { name: ride.name, distanceM: ride.distanceM, windows: obs.length, avgRoughness: ride.avgScore,
    comfortScore: Math.round(comfort) }, windowCounts: counts, hazardsOnRoute: hazards };
  try {
    const res = await generate({
      contents: `Summarise this ride for the rider in under 110 words: a comfort verdict, the 2-3 worst spots (by hazard id), and one tip for contributing better data next time. Data: ${JSON.stringify(data)}`,
      config: { temperature: 0.5 },
    });
    return { text: res.text, source: 'gemini', data };
  } catch (e) {
    const worst = hazards.slice(0, 3).map((h) => h.id).join(', ') || 'none';
    return {
      text: `Ride comfort **${Math.round(comfort)}/100** over ${(ride.distanceM / 1000).toFixed(2)} km. ` +
        `${counts.bump || 0} impact window(s), ${counts.rough || 0} rough window(s). Worst spots: ${worst}. ` +
        `Tip: ride the same route again so repeated detections can raise confidence.`,
      source: 'fallback', error: reason(e), data,
    };
  }
}

// ---------------------------------------------------------------- second opinion on one window

const OPINION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING, enum: ['smooth', 'joint', 'rough', 'bump'] },
    confidence: { type: Type.NUMBER },
    agreesWithModel: { type: Type.BOOLEAN },
    explanation: { type: Type.STRING, description: '2 sentences, plain language, cite feature values' },
  },
  required: ['label', 'confidence', 'agreesWithModel', 'explanation'],
};

export async function secondOpinion({ features, waveform, prediction }) {
  try {
    const res = await generate({
      contents: `A 0.5 s window of scooter vibration. Accelerometer magnitude in g (gravity ≈ 1.0), sampled at ~${features.fs} Hz:
${JSON.stringify(waveform)}
Extracted features: ${JSON.stringify(features)}
On-device model said "${prediction.label}" (${Math.round(prediction.confidence * 100)}%).
Classes: smooth (normal riding), joint (one brief spike from a sidewalk seam/crack), rough (sustained broadband vibration from broken or coarse surface), bump (large impact, often a pothole edge, with a second hit from the rear wheel).
Give your own classification and explain it.`,
      config: { responseMimeType: 'application/json', responseSchema: OPINION_SCHEMA, temperature: 0.1 },
    });
    return { ...JSON.parse(res.text), source: 'gemini' };
  } catch (e) {
    return { label: prediction.label, confidence: prediction.confidence, agreesWithModel: true,
      explanation: 'Gemini unavailable (' + reason(e) + '). Showing the on-device prediction.', source: 'fallback' };
  }
}

// ---------------------------------------------------------------- trash scanner + upcycling

const IDEA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Catchy product name' },
    pitch: { type: Type.STRING, description: 'One sentence: what it is and why it is useful' },
    usesFromHome: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Exact items from the home stash it uses' },
    extraNeeded: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Common supplies needed that are not in the stash (glue, string…)' },
    tools: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Tools needed (scissors, craft knife, drill...); empty if none' },
    steps: { type: Type.ARRAY, items: { type: Type.STRING }, description: '4-7 short, concrete steps with sizes or amounts where useful' },
    impact: { type: Type.STRING, description: 'What it keeps out of landfill, e.g. "2 plastic bottles and a jar"' },
    minutes: { type: Type.INTEGER },
    difficulty: { type: Type.STRING, enum: ['easy', 'medium', 'hard'] },
    safety: { type: Type.STRING, description: 'Cleaning / handling advice for found litter' },
  },
  required: ['title', 'pitch', 'usesFromHome', 'extraNeeded', 'steps', 'minutes', 'difficulty', 'safety'],
};

const SCAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    trashDetected: { type: Type.BOOLEAN, description: 'Is there litter / discarded waste on the ground or path?' },
    confidence: { type: Type.NUMBER },
    items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
      name: { type: Type.STRING },
      material: { type: Type.STRING, enum: ['plastic', 'glass', 'metal', 'paper', 'cardboard', 'textile', 'organic', 'electronic', 'hazardous', 'mixed'] },
      pickupSafe: { type: Type.BOOLEAN, description: 'false for needles, broken glass, batteries, chemicals' },
    }, required: ['name', 'material', 'pickupSafe'] } },
    summary: { type: Type.STRING, description: 'Short alert text, e.g. "Plastic bottle and a coffee cup on the path"' },
    pollutionVisible: { type: Type.STRING, description: 'Visible air/water pollution such as smoke, exhaust, oil spill, or "none"' },
    roadHazardVisible: { type: Type.STRING, description: 'Visible pothole/crack/obstruction, or "none"' },
    idea: IDEA,
  },
  required: ['trashDetected', 'confidence', 'items', 'summary', 'pollutionVisible', 'roadHazardVisible'],
};

const stashText = (inv) => (inv.length
  ? inv.map((i) => `${i.qty || 1}x ${i.name}${i.material ? ` (${i.material})` : ''}`).join(', ')
  : '(empty: assume only basic household supplies)');

/** One call: detect litter in a camera frame AND invent a product from it plus the home stash. */
export async function scanTrash({ imageBase64, mimeType, inventory = [], focus = '' }) {
  const t0 = Date.now();
  const res = await generate({
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType, data: imageBase64 } },
      { text: `This frame comes from a phone mounted on a kick scooter, looking at the path ahead.
1) Detect litter on the ground or path (ignore bins, parked items and anything still in use). List each item.
2) Note visible pollution and road hazards.
3) If trash is detected and safe to pick up, invent ONE practical, fun product the rider could make by combining that trash with things already in their home stash: ${stashText(inventory)}. Prefer items from the stash. Omit "idea" if there is no trash or nothing is safe to handle.${focus ? `
${focus}` : ''}` },
    ] }],
    config: { responseMimeType: 'application/json', responseSchema: SCAN_SCHEMA, temperature: 0.4 },
  });
  const out = JSON.parse(res.text);
  if (out.idea) { store.getDb().upcycleIdeas++; store.save(); }
  return { ...out, source: 'gemini', model: MODEL, ms: Date.now() - t0 };
}

export async function upcycleIdea({ items = [], inventory = [], goal = '', difficulty = '', maxMinutes = 0, mustUse = false }) {
  try {
    const wants = [goal && `What they want: ${goal}.`, difficulty && `Difficulty: ${difficulty}.`,
      maxMinutes && `It must take at most ${maxMinutes} minutes.`].filter(Boolean).join('\n');
    const res = await generate({
      contents: `${mustUse ? 'Materials the person wants to use' : 'Found trash'}: ${items.map((i) => `${i.name}${i.material ? ` (${i.material})` : ''}`).join(', ') || 'none, use only the stash'}.
Home stash: ${stashText(inventory)}.
${wants}
Invent ONE practical, genuinely useful product to make${mustUse ? ', built mainly from the materials they named' : ' by combining them'}. Use stash items by their exact names.
Make it doable at home by a beginner with common tools: clear steps with sizes or amounts, no sharp or broken glass,
nothing that would hold food if it was found litter, and clean found litter first. Say what it keeps out of landfill.`,
      config: { responseMimeType: 'application/json', responseSchema: IDEA, temperature: 0.8 },
    });
    store.getDb().upcycleIdeas++;
    store.save();
    return { idea: JSON.parse(res.text), source: 'gemini' };
  } catch (e) {
    return { idea: fallbackIdea(items, inventory), source: 'fallback', error: reason(e) };
  }
}

const INVENTORY_SCHEMA = {
  type: Type.OBJECT,
  properties: { items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    name: { type: Type.STRING }, material: { type: Type.STRING }, qty: { type: Type.INTEGER },
  }, required: ['name', 'material', 'qty'] } } },
  required: ['items'],
};

export async function scanInventory({ imageBase64, mimeType }) {
  const res = await generate({
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType, data: imageBase64 } },
      { text: 'List the reusable or recyclable household items in this photo (jars, bottles, boxes, cans, old clothes, corks, cartons, etc.) that could be used for DIY upcycling. Short names, best-guess quantities.' },
    ] }],
    config: { responseMimeType: 'application/json', responseSchema: INVENTORY_SCHEMA, temperature: 0.2 },
  });
  return JSON.parse(res.text);
}

/** Demo detections so the whole flow works without a camera or an API key. */
export const DEMO_TRASH = [
  { name: 'plastic water bottle', material: 'plastic' },
  { name: 'aluminium soda can', material: 'metal' },
  { name: 'cardboard coffee cup', material: 'cardboard' },
  { name: 'glass jar', material: 'glass' },
  { name: 'plastic bag', material: 'plastic' },
];

export function fallbackIdea(items, inventory) {
  const mat = items[0]?.material || 'plastic';
  const has = (re) => inventory.find((i) => re.test(i.name))?.name;
  const T = {
    plastic: { title: 'Self-watering herb planter', pitch: 'Cut the bottle in half and invert the top into the base so a fabric wick keeps the soil moist.',
      uses: [has(/t-?shirt|cloth|sock|fabric/i), has(/jar|pot|seed/i)],
      steps: ['Wash the bottle and cut it a third of the way from the top.', 'Thread a strip of fabric through the cap as a wick.', 'Flip the top into the base and add soil and seeds.', 'Fill the base with water.'] },
    metal: { title: 'Desk organiser caddy', pitch: 'Clean cans become a tidy holder for pens and tools.',
      uses: [has(/can|tin/i), has(/cardboard|box/i)],
      steps: ['Wash the can and tape over the rim.', 'Wrap it in fabric or paper.', 'Glue several cans to a cardboard base.'] },
    glass: { title: 'Jar lantern', pitch: 'A wire handle and a tea light turn a jar into a garden lantern.',
      uses: [has(/string|twine|wire/i), has(/candle/i)],
      steps: ['Clean the jar and remove the label.', 'Twist wire or string around the neck as a handle.', 'Add sand and a tea light.'] },
    cardboard: { title: 'Seed-starter tray', pitch: 'Cardboard cups become compostable seedling pots.',
      uses: [has(/egg|carton|box/i)],
      steps: ['Cut the cardboard into small cups.', 'Fill with soil and seeds.', 'Plant the whole cup once seedlings sprout.'] },
  };
  const t = T[mat] || T.plastic;
  return { title: t.title, pitch: t.pitch, usesFromHome: t.uses.filter(Boolean), extraNeeded: ['scissors', 'glue'],
    steps: t.steps, minutes: 20, difficulty: 'easy', safety: 'Wear gloves when picking up litter and wash items in soapy water before use.' };
}

// ---------------------------------------------------------------- data agent (function calling)

export const TOOLS = [{
  functionDeclarations: [
    { name: 'get_stats', description: 'Overall survey statistics: rides, km, observations, hazard counts, verification precision, model info.',
      parameters: { type: Type.OBJECT, properties: {} } },
    { name: 'list_hazards', description: 'Hazard locations ranked by repair priority.',
      parameters: { type: Type.OBJECT, properties: {
        status: { type: Type.STRING, enum: ['unverified', 'confirmed', 'dismissed', 'fixed'] },
        type: { type: Type.STRING, enum: ['rough', 'bump'] },
        minReports: { type: Type.INTEGER, description: 'Minimum independent rides that detected it' },
        limit: { type: Type.INTEGER },
      } } },
    { name: 'get_hazard', description: 'Full detail for one hazard, by id like "H4" or number 4.',
      parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING } }, required: ['id'] } },
    { name: 'roughest_segments', description: 'Map grid cells (~25 m) with the highest average roughness score (0-100).',
      parameters: { type: Type.OBJECT, properties: { limit: { type: Type.INTEGER } } } },
    { name: 'pollution_hotspots', description: 'Map cells (~25 m) where average street-level PM2.5 is at or above 35.5 µg/m³.',
      parameters: { type: Type.OBJECT, properties: { limit: { type: Type.INTEGER } } } },
    { name: 'list_litter', description: 'Litter riders reported and left for clean-up (ids like L3), plus how many items riders picked up themselves.',
      parameters: { type: Type.OBJECT, properties: { limit: { type: Type.INTEGER } } } },
    { name: 'list_rides', description: 'Recorded rides with distance, average roughness and hazard hits.',
      parameters: { type: Type.OBJECT, properties: { limit: { type: Type.INTEGER } } } },
  ],
}];

export function runTool(name, args = {}) {
  switch (name) {
    case 'get_stats': return store.stats();
    case 'list_hazards':
      return store.listHazards({ status: args.status, minReports: args.minReports || 1 })
        .filter((h) => !args.type || h.type === args.type).slice(0, args.limit || 10).map(compactHazard);
    case 'get_hazard': {
      const h = store.getHazard(String(args.id).replace(/^H/i, ''));
      return h ? { ...compactHazard(h), votes: h.votes, firstSeen: h.firstSeen, hits: h.hits } : { error: 'not found' };
    }
    case 'roughest_segments':
      return store.roughnessGrid().filter((c) => c.n >= 3).sort((a, b) => b.score - a.score).slice(0, args.limit || 8);
    case 'pollution_hotspots': return store.pollutionHotspots().slice(0, args.limit || 8);
    case 'list_litter': {
      const db = store.getDb();
      return {
        onMap: db.litter.filter((l) => l.status === 'reported').slice(-(args.limit || 15)).map((l) => ({ id: `L${l.no}`, items: l.items, lat: l.lat, lng: l.lng, at: l.at })),
        cleared: db.litter.filter((l) => l.status === 'cleared').length,
        pickedUpByRiders: db.pickups.reduce((n, p) => n + p.count, 0),
      };
    }
    case 'list_rides':
      return store.getDb().rides.slice(-(args.limit || 10)).map(({ summary, ...r }) => r);
    default: return { error: 'unknown tool' };
  }
}

/** Model ids this key can use whose name mentions images (for picking an image model). */
export async function imageModels() {
  if (!ai) return [];
  const names = [];
  const pager = await ai.models.list({ config: { pageSize: 200 } });
  for await (const m of pager) if (/image|imagen/i.test(m.name)) names.push({ name: m.name.replace(/^models\//, ''), actions: m.supportedActions });
  return names;
}

/** Local one-line city summary used when Gemini is unavailable. */
export function cityFallback() {
  const s = store.stats();
  const top = store.listHazards().slice(0, 3).map((h) => `**H${h.no}** (${h.typeLabel}, ${h.reports} rides)`).join(', ');
  return `${s.distanceKm} km surveyed, ${s.hazards} active hazards (${s.confirmed} confirmed). Top priorities: ${top || 'none yet'}.`;
}

export function reason(e) {
  if (e?.fallback) return 'no API key configured';
  let m = String(e?.message || e);
  try { m = JSON.parse(m).error?.message || m; } catch {}
  return m.length > 140 ? m.slice(0, 140) + '…' : m;
}

