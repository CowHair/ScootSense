import { config } from './config.js';
const modes = { walking: 'foot', cycling: 'bike', driving: 'car' };
export function validCoordinate(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 90 && Math.abs(value[1]) <= 180;
}
const addresses = new Map();
let addressQueue = Promise.resolve(), lastLookup = 0;
const placePhotos = new Map();
export function mountRoutes(app) {
  app.get('/api/place-photo', async (req,res) => {
    const point = [Number(req.query.lat), Number(req.query.lng)];
    if (!validCoordinate(point)) return res.status(400).json({error:'Invalid location'});
    const key = point.map(n => n.toFixed(5)).join(',');
    if (!placePhotos.has(key)) placePhotos.set(key, (async () => {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      url.search = new URLSearchParams({action:'query',format:'json',generator:'geosearch',ggscoord:point.join('|'),ggsradius:'100',ggsnamespace:'6',ggslimit:'5',prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'640'});
      const response = await fetch(url,{headers:{'User-Agent':'ScootSense/1.0 location-preview'},signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw Error('Photo service unavailable');
      const result = await response.json();
      const pages = Object.values(result.query?.pages || {}).sort((a,b) => a.index-b.index);
      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info?.thumburl || !info.thumburl.startsWith('https://upload.wikimedia.org/')) continue;
        const plain = value => String(value || '').replace(/<[^>]*>/g,'').slice(0,250);
        return {url:info.thumburl,source:info.descriptionurl,title:page.title.replace(/^File:/,''),credit:plain(info.extmetadata?.Artist?.value),license:plain(info.extmetadata?.LicenseShortName?.value)};
      }
      return {url:null};
    })());
    try { res.json(await placePhotos.get(key)); } catch { placePhotos.delete(key); res.status(503).json({url:null}); }
    if(placePhotos.size>300)placePhotos.delete(placePhotos.keys().next().value);
  });
  app.get('/api/spot-address', async (req, res) => {
    const point = [Number(req.query.lat), Number(req.query.lng)];
    if (!validCoordinate(point)) return res.status(400).json({ error: 'Invalid coordinates' });
    const key = point.map(n => n.toFixed(5)).join(',');
    if (!addresses.has(key)) {
      const task = addressQueue.then(async () => {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - lastLookup))));
        lastLookup = Date.now();
        const base = config.REVERSE_GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse';
        const url = new URL(base);
        url.search = new URLSearchParams({ format: 'jsonv2', lat: point[0], lon: point[1], zoom: 18 });
        const r = await fetch(url, { headers: { 'User-Agent': 'ScootSense/1.0 spot-address-lookup' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw Error('Address lookup unavailable');
        const result = await r.json();
        return { address: result.display_name || 'Address unavailable' };
      });
      addresses.set(key, task);
      addressQueue = task.catch(() => {});
      if (addresses.size > 500) addresses.delete(addresses.keys().next().value);
    }
    try { res.json(await addresses.get(key)); }
    catch { addresses.delete(key); res.status(503).json({ error: 'Address lookup unavailable' }); }
  });
  app.get('/api/route-config', (_req, res) => res.json({ googleEmbedKey: config.GOOGLE_MAPS_EMBED_KEY || null }));
  app.post('/api/directions', async (req, res) => {
    const { origin, destination, mode } = req.body;
    res.set('Cache-Control', 'no-store');
    if (!validCoordinate(origin) || !validCoordinate(destination) || !modes[mode]) return res.status(400).json({ error: 'Choose valid start/end coordinates and a supported travel mode.' });
    const coordinates = [origin, destination].map(([lat,lng]) => `${lng},${lat}`).join(';');
    try {
      const response = await fetch(`https://routing.openstreetmap.de/routed-${modes[mode]}/route/v1/${modes[mode]}/${coordinates}?overview=full&geometries=geojson&steps=true`, { headers: { 'User-Agent': 'ScootSense/1.0 route-planner' }, signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok) return res.status(503).json({ error: response.status === 429
        ? 'The public routing service is rate-limiting requests. Wait a moment and retry.'
        : 'The public routing provider failed to process this request. Try again shortly.' });
      if (data.code !== 'Ok' || !data.routes?.length) return res.status(422).json({ error: ['NoRoute', 'NoSegment'].includes(data.code)
        ? 'These points could not be connected to the road/path network. Check both latitude/longitude values. Local XYZ sensor values cannot be used as GPS positions.'
        : 'The routing provider rejected this route request. Check the coordinates and try again.' });
      const route = data.routes[0];
      res.json({ distance: route.distance, duration: route.duration, geometry: route.geometry,
        steps: route.legs.flatMap(leg => leg.steps.map(step => ({ distance: step.distance, name: step.name, type: step.maneuver.type, modifier: step.maneuver.modifier, exit: step.maneuver.exit }))),
        attribution: 'Routing by FOSSGIS / OSRM · © OpenStreetMap contributors', mode });
    } catch { res.status(503).json({ error: 'The public routing service is temporarily unavailable. Please try again shortly.' }); }
  });
}
