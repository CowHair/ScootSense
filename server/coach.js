// "Ask Scootie": the ScootSense eco buddy (Gemini underneath). It knows the rider's own data (rides, trash list,
// home stash) and the city's (hazards, litter, air), and answers with concrete next steps:
// a project to make from collected litter (with a generated picture), a cleanup route,
// a ready-to-send 311 report, or a carbon summary. Structured results come back as
// "cards" the app renders with buttons, so answers are things you can act on.
import { Type } from '@google/genai';
import * as gemini from './gemini.js';
import * as store from './store.js';
import * as users from './userdb.js';
import * as trash from './trashdb.js';
import { computeImpact } from './impact.js';
import { haversine } from '../shared/signal.js';

const CAMPUS = { lat: 43.7843, lng: -79.1885 };

const SYSTEM = `You are Scootie, the friendly eco buddy inside ScootSense, an app where kick-scooter riders map
potholes, air pollution and litter, and turn litter into useful things. Speak as Scootie: upbeat, kind,
practical, never preachy. You may sign off now and then with a short scooter pun, but keep it rare.
Goals: cut emissions, keep waste out of landfill (circular economy), encourage sustainable choices,
and help people take real action in their city (Toronto / Scarborough).
Style: warm, plain language, short sentences. Most answers under 110 words. Use short bullet lists.
Always end with ONE concrete next step the person can do today.
Ground every number in a tool result. Never invent data. Impact numbers are estimates: say "about".
PROJECTS: whenever the person asks for a project, an idea, a craft, a DIY, what to make or build, or how to
reuse or upcycle something, you MUST call suggest_project. Never describe a project only in text.
Pass what they told you: the materials they mention (in "materials", e.g. ["plastic bottle", "old t-shirt"]),
what they want to end up with ("goal", e.g. "a bird feeder", "something for my balcony", "a gift"),
and "difficulty" / "maxMinutes" if they say how hard or how long. If they name no materials, leave
"materials" empty and the project uses their picked-up litter and home items. After the card, add one
sentence on why it helps (waste kept out of landfill) and invite them to save it or ask for another.
For cleanups, call plan_cleanup_route.
To contact the city, call draft_city_report. For their footprint or savings, call get_my_impact.
The app shows tool results as cards with buttons (pictures, maps, copy), so do not repeat every
detail of a card in your text: summarise in one or two sentences and point to the card below your message.
Project cards draw a picture of the finished project automatically. If the person asks to see
a picture of a project you already suggested, do not call suggest_project again: tell them the
picture is on that card (with a Try again button if it could not load). Only call it again when
they want a different project.`;

// ---------------------------------------------------------------- personal tools

const PERSONAL_TOOLS = [
  { name: 'get_my_impact', description: "The rider's estimated CO2 saved by riding instead of driving and by picking up litter, km ridden, waste diverted.",
    parameters: { type: Type.OBJECT, properties: {} } },
  { name: 'get_my_items', description: "Litter the rider picked up (their trash list) and the reusable items they have at home.",
    parameters: { type: Type.OBJECT, properties: {} } },
  { name: 'suggest_project', description: 'Design one upcycling project. Uses the materials the person mentions, otherwise their picked-up litter and home items. The app shows it as a card with materials, tools, steps, safety notes, the waste it saves, and an AI-generated picture of the finished project.',
    parameters: { type: Type.OBJECT, properties: {
      materials: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Things the person says they have or want to use, e.g. ["2 plastic bottles", "a glass jar"]' },
      goal: { type: Type.STRING, description: 'What they want to make or a theme, e.g. "a bird feeder", "for the garden", "a gift"' },
      difficulty: { type: Type.STRING, enum: ['easy', 'medium', 'hard'] },
      maxMinutes: { type: Type.INTEGER, description: 'Time they have, if they said' },
      focus: { type: Type.STRING, description: 'Older name for goal' },
    } } },
  { name: 'plan_cleanup_route', description: 'A short scooter route through the nearest litter pins on the shared map, with a Google Maps link.',
    parameters: { type: Type.OBJECT, properties: { stops: { type: Type.INTEGER, description: 'How many pins to visit (2-6)' } } } },
  { name: 'draft_city_report', description: 'A ready-to-send Toronto 311 report for a hazard (id like H4) or litter pin (id like L3). If no id is given, picks the highest-priority hazard.',
    parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING } } } },
  { name: 'get_air_quality', description: 'Current regional air quality at the rider\'s location plus street-level pollution hotspots measured by riders.',
    parameters: { type: Type.OBJECT, properties: {} } },
];

const TOOLS = [{ functionDeclarations: [...PERSONAL_TOOLS, ...gemini.TOOLS[0].functionDeclarations] }];

async function where(who) {
  return (who && (await trash.getPresence(who, 30 * 60_000))) || CAMPUS;
}

async function myItems(uid) {
  if (!uid) return { trash: [], stash: [] };
  const [t, s] = await Promise.all([trash.listUserTrash(uid), users.getStash(uid)]);
  return { trash: t, stash: s };
}

async function runPersonalTool(name, args, ctx) {
  const { uid, who } = ctx;
  switch (name) {
    case 'get_my_impact': {
      if (!uid) return { note: 'The rider is a guest, so there is no saved history yet. Encourage creating an account.' };
      const [summary, { trash: t }] = await Promise.all([users.activitySummary(uid), myItems(uid)]);
      return computeImpact(summary.totals, t);
    }
    case 'get_my_items': {
      const { trash: t, stash } = await myItems(uid);
      return { pickedUp: t.slice(0, 20).map((x) => ({ name: x.name, material: x.material, when: x.time })), home: stash };
    }
    case 'suggest_project': {
      const { trash: t, stash } = await myItems(uid);
      const inventory = stash.length ? stash : ctx.clientStash || [];
      const named = (Array.isArray(args.materials) ? args.materials : []).map((m) => String(m).trim()).filter(Boolean).slice(0, 8);
      // What they asked to use comes first; otherwise the litter they picked up.
      const items = named.length ? named.map((name) => ({ name, material: '' }))
        : t.slice(0, 3).map((x) => ({ name: x.name, material: x.material }));
      const { idea, source } = await gemini.upcycleIdea({ items, inventory, goal: args.goal || args.focus || '',
        difficulty: args.difficulty, maxMinutes: args.maxMinutes, mustUse: named.length > 0 });
      const card = { type: 'project', idea, from: named.length ? [] : items.map((i) => i.name) };
      ctx.cards.push(card);
      return { shownToUserAsCard: true, title: idea.title, pitch: idea.pitch, uses: [...(idea.usesFromHome || []), ...(idea.extraNeeded || [])],
        minutes: idea.minutes, difficulty: idea.difficulty, savesFromLandfill: idea.impact, source };
    }
    case 'plan_cleanup_route': {
      const start = await where(who);
      const n = Math.max(2, Math.min(6, args.stops || 4));
      let pool = (await trash.listLitter()).filter((l) => l.status === 'reported');
      const route = [];
      let at = start;
      while (route.length < n && pool.length) { // greedy nearest-neighbour is plenty for a few stops
        pool.sort((a, b) => haversine(at, a) - haversine(at, b));
        const next = pool.shift();
        route.push({ id: `L${next.no}`, lat: next.lat, lng: next.lng, items: next.items.map((i) => i.name), metresFromLast: Math.round(haversine(at, next)) });
        at = next;
      }
      if (!route.length) return { note: 'No litter is pinned on the map right now.' };
      const pt = (p) => `${p.lat},${p.lng}`;
      const url = `https://www.google.com/maps/dir/?api=1&origin=${pt(start)}&destination=${pt(route.at(-1))}`
        + (route.length > 1 ? `&waypoints=${route.slice(0, -1).map(pt).join('|')}` : '') + '&travelmode=bicycling';
      const km = Math.round(route.reduce((s, r) => s + r.metresFromLast, 0) / 100) / 10;
      ctx.cards.push({ type: 'route', stops: route, url, km });
      return { shownToUserAsCard: true, stops: route.length, totalKm: km };
    }
    case 'draft_city_report': {
      const report = await cityReport(args.id);
      if (!report) return { error: 'Nothing found with that id' };
      ctx.cards.push({ type: 'report', ...report });
      return { shownToUserAsCard: true, subject: report.subject };
    }
    case 'get_air_quality': {
      const p = await where(who);
      let regional = null;
      try {
        const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lng}&current=pm2_5,us_aqi`).then((x) => x.json());
        regional = r.current ? { pm25: r.current.pm2_5, usAqi: r.current.us_aqi } : null;
      } catch {}
      const hotspots = store.pollutionHotspots().map((h) => ({ ...h, metresAway: Math.round(haversine(p, h)) })).slice(0, 4);
      return { regional, streetLevelHotspots: hotspots, note: 'WHO 24-hour PM2.5 guideline is 15 µg/m³.' };
    }
    default:
      return gemini.runTool(name, args);
  }
}

/** A plain, factual 311 report the rider can copy or paste into the city's form. */
async function cityReport(id) {
  let raw = String(id || '').trim().toUpperCase();
  if (!raw) raw = `H${store.listHazards()[0]?.no ?? ''}`;
  const maps = (p) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;
  if (raw.startsWith('L')) {
    const l = await trash.getLitter(raw.slice(1));
    if (!l) return null;
    return {
      subject: `Litter to collect near ${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`,
      body: `Hello 311,\n\nThere is litter on a path used by cyclists and pedestrians: ${l.items.map((i) => i.name).join(', ')}.`
        + `\nLocation: ${l.lat.toFixed(5)}, ${l.lng.toFixed(5)} (${maps(l)})`
        + `\nFirst reported: ${new Date(l.at).toDateString()}. Last confirmed still there: ${new Date(l.lastSeen || l.at).toDateString()}.`
        + `\n\nCould a crew please collect it? Thank you.\n\n(Reported with ScootSense, a community road and litter map.)`,
      link: 'https://www.toronto.ca/home/311-toronto-at-your-service/',
    };
  }
  const h = store.getHazard(raw.replace(/^H/, ''));
  if (!h) return null;
  return {
    subject: `${h.typeLabel} on a cycling route near ${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}`,
    body: `Hello 311,\n\nI'd like to report a ${h.typeLabel.toLowerCase()} affecting cyclists, scooter riders and wheelchair users.`
      + `\nLocation: ${h.lat.toFixed(5)}, ${h.lng.toFixed(5)} (${maps(h)})`
      + `\nEvidence: detected by vibration sensors on ${h.reports} separate rides (severity ${h.severity}/100)`
      + `${h.votes.confirm ? `, confirmed by ${h.votes.confirm} rider${h.votes.confirm > 1 ? 's' : ''}` : ''}${h.photos.length ? `, with ${h.photos.length} photo check${h.photos.length > 1 ? 's' : ''}` : ''}.`
      + `\nFirst seen ${new Date(h.firstSeen).toDateString()}, most recently ${new Date(h.lastSeen).toDateString()}.`
      + `\n\nCould this be inspected and repaired? Thank you.\n\n(Reported with ScootSense, a community road and litter map.)`,
    link: 'https://www.toronto.ca/home/311-toronto-at-your-service/',
  };
}

// ---------------------------------------------------------------- chat loop

export async function chat({ message, history = [], uid, who, clientStash }) {
  const ctx = { uid, who, clientStash, cards: [] };
  const contents = [
    ...history.slice(-10).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.text).slice(0, 2000) }] })),
    { role: 'user', parts: [{ text: String(message).slice(0, 2000) }] },
  ];
  const trace = [];
  try {
    for (let step = 0; step < 5; step++) {
      const res = await gemini.generate({ contents, config: { systemInstruction: SYSTEM, tools: TOOLS, temperature: 0.4 } });
      const calls = res.functionCalls || [];
      if (!calls.length) return { text: res.text, trace, cards: ctx.cards, source: 'gemini' };
      contents.push(res.candidates[0].content);
      const parts = [];
      for (const c of calls) {
        trace.push({ tool: c.name, args: c.args });
        let result;
        try { result = await runPersonalTool(c.name, c.args || {}, ctx); } catch (e) { result = { error: String(e.message).slice(0, 200) }; }
        parts.push({ functionResponse: { name: c.name, response: { result } } });
      }
      contents.push({ role: 'user', parts });
    }
    return { text: "That needed a lot of lookups. Here's what I found so far.", trace, cards: ctx.cards, source: 'gemini' };
  } catch (e) {
    return offline(message, ctx, e);
  }
}

/** Without Gemini, still answer the common requests by calling the same tools directly. */
async function offline(message, ctx, e) {
  const m = message.toLowerCase();
  const note = `_Gemini is unavailable (${gemini.reason(e)}), so this is a simpler offline answer._\n\n`;
  if (/make|build|craft|project|upcycl|diy|idea|trash|litter i|reuse/.test(m)) {
    await runPersonalTool('suggest_project', { goal: message.slice(0, 120) }, ctx);
    return { text: `${note}Here's something you could make from what you've collected:`, cards: ctx.cards, trace: [], source: 'fallback' };
  }
  if (/clean ?up|route|pick up|collect/.test(m)) {
    const r = await runPersonalTool('plan_cleanup_route', { stops: 4 }, ctx);
    return { text: note + (r.note || `A ${r.totalKm} km cleanup loop through ${r.stops} litter pins:`), cards: ctx.cards, trace: [], source: 'fallback' };
  }
  if (/311|report|city|council/.test(m)) {
    await runPersonalTool('draft_city_report', {}, ctx);
    return { text: `${note}Here's a ready-to-send report for the highest-priority hazard:`, cards: ctx.cards, trace: [], source: 'fallback' };
  }
  if (/carbon|co2|impact|saved|footprint/.test(m)) {
    const r = await runPersonalTool('get_my_impact', {}, ctx);
    const text = r.note || `You've ridden about **${r.km} km**, saving about **${r.co2RideKg} kg CO2** versus driving, and kept **${r.itemsPickedUp} items** (about ${r.wasteDivertedKg} kg) out of landfill. That's about **${r.co2TotalKg} kg CO2** in total.`;
    return { text: note + text, cards: [], trace: [], source: 'fallback' };
  }
  if (/plan|week|habit|tips|goal/.test(m)) {
    return { text: note + [
      '**Your 7-day eco plan**',
      '1. **Mon:** Ride to class or work instead of driving (about 0.17 kg CO2 saved per km).',
      '2. **Tue:** Pick up one piece of litter on your ride and log it.',
      '3. **Wed:** Check the map and confirm or dismiss one hazard near you.',
      '4. **Thu:** Make a project from something on your trash list.',
      '5. **Fri:** Send one 311 report for the worst hazard on your route.',
      '6. **Sat:** Do a 30-minute cleanup ride with a friend.',
      '7. **Sun:** Look at your CO2 savings on the Me tab and set a goal for next week.',
    ].join('\n'), cards: [], trace: [], source: 'fallback' };
  }
  return { text: note + gemini.cityFallback(), cards: [], trace: [], source: 'fallback' };
}

// ---------------------------------------------------------------- "show me": a picture of the finished project

const IMAGE_MODELS = [process.env.GEMINI_IMAGE_MODEL, 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'].filter(Boolean);
let workingImageModel = null;

/** Our preferred names first, then any other image-output Gemini model this key can see. */
async function candidateImageModels() {
  let available = [];
  try { available = (await gemini.imageModels()).filter((m) => m.actions?.includes('generateContent') && /gemini/.test(m.name)).map((m) => m.name); } catch {}
  const preferred = IMAGE_MODELS.filter((m) => !available.length || available.includes(m));
  return [...new Set([...preferred, ...available])];
}

// ---------------------------------------------------------------- Cloudflare Workers AI (free daily allowance)

const cloudflareReady = () => Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
const CF_MODELS = ['@cf/black-forest-labs/flux-1-schnell', '@cf/stabilityai/stable-diffusion-xl-base-1.0'];

async function cloudflareImage(prompt, tried) {
  for (const model of CF_MODELS) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID.trim()}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(model.includes('flux') ? { prompt, steps: 6 } : { prompt, num_steps: 20 }),
        signal: AbortSignal.timeout(45_000),
      });
      const type = res.headers.get('content-type') || '';
      if (!res.ok) {
        const body = await res.text();
        tried.push(`${model}: ${res.status} ${body.slice(0, 120)}`);
        continue;
      }
      // FLUX answers JSON with a base64 JPEG; Stable Diffusion answers the PNG bytes.
      if (type.includes('json')) {
        const j = await res.json();
        if (j.result?.image) return { image: `data:image/jpeg;base64,${j.result.image}`, model: model.split('/').pop() };
        tried.push(`${model}: no image in reply`);
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        return { image: `data:${type || 'image/png'};base64,${buf.toString('base64')}`, model: model.split('/').pop() };
      }
    } catch (e) {
      tried.push(`${model}: ${e.message}`);
    }
  }
  return null;
}

export async function projectImage(idea) {
  const materials = [...(idea.usesFromHome || []), ...(idea.extraNeeded || [])].join(', ');
  const prompt = `A realistic, bright product photo of a finished handmade upcycled project called "${idea.title}". ${idea.pitch}`
    + ` It is clearly made from reused materials: ${materials || 'found litter and household items'}.`
    + ' Show the finished object in use in a cosy, sunlit home or garden setting, eco-friendly DIY style, shallow depth of field.'
    + ' No text, no logos, no people.';
  // A Gemini image model that already worked goes first; otherwise Cloudflare's free FLUX
  // (when configured) is quicker than walking Gemini models that the free tier refuses.
  let lastError = null;
  const tried = [];
  if (!workingImageModel && cloudflareReady()) {
    const out = await cloudflareImage(prompt, tried);
    if (out) return out;
  }
  const models = workingImageModel ? [workingImageModel] : await candidateImageModels();
  for (const model of models) {
    try {
      const res = await gemini.generate({ model, contents: prompt, config: { systemInstruction: undefined, responseModalities: ['TEXT', 'IMAGE'] } });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) { lastError = new Error('No image returned'); continue; }
      workingImageModel = model;
      return { image: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`, model };
    } catch (e) {
      lastError = e;
      tried.push(`${model}: ${gemini.reason(e).slice(0, 90)}`);
      if (e.fallback) break; // no API key at all
    }
  }
  if (workingImageModel && cloudflareReady()) {
    const out = await cloudflareImage(prompt, tried);
    if (out) return out;
  }
  if (tried.length) console.warn('image generation failed:', tried.join(' | '));
  const why = gemini.reason(lastError);
  return { error: /quota|billing|free|limit|RESOURCE_EXHAUSTED|429/i.test(why)
    ? (cloudflareReady() ? 'Both image services are busy right now. Try again in a minute.' : 'Image generation is not included in this Gemini key\'s free tier.')
    : `Could not draw it right now (${why}).` };
}
