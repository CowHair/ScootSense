import { CLASS_INFO, airSpotLook } from '/shared/signal.js';

const LIB = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl';
const STYLE = 'https://tiles.openfreemap.org/styles/liberty';

let gl = null;
let loading = null;
let me = null;

function loadLib() {
  if (window.maplibregl) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LIB}.css`;
    document.head.append(css);
    const js = document.createElement('script');
    js.src = `${LIB}.js`;
    js.onload = resolve;
    js.onerror = () => { loading = null; reject(new Error('Could not load the 3D map. Check your connection.')); };
    document.head.append(js);
  });
  return loading;
}

function square(lat, lng, metres) {
  const dLat = metres / 111320;
  const dLng = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  return [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]];
}

function toGeo(data) {
  const hazards = (data.hazards || []).filter((h) => h.status !== 'dismissed' && h.status !== 'fixed').map((h) => ({
    type: 'Feature',
    properties: { no: h.no, sev: h.severity || 0, color: CLASS_INFO[h.type]?.color || '#F44336' },
    geometry: { type: 'Polygon', coordinates: square(h.lat, h.lng, 3.2) },
  }));
  const litter = (data.litter || []).filter((l) => l.status !== 'cleared').map((l) => ({
    type: 'Feature', properties: { no: l.no }, geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
  }));
  const air = (data.hot || []).map((p) => ({
    type: 'Feature', properties: { color: airSpotLook(p).color }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }));
  const fc = (features) => ({ type: 'FeatureCollection', features });
  return { hazards: fc(hazards), litter: fc(litter), air: fc(air) };
}

function addLayers(onPick) {
  const style = gl.getStyle();
  if (!style.layers.some((l) => l.type === 'fill-extrusion') && style.sources.openmaptiles) {
    gl.addLayer({
      id: 'ss-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      paint: { 'fill-extrusion-color': '#D9DAD5', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.85 },
    });
  }
  const empty = { type: 'FeatureCollection', features: [] };
  for (const id of ['hazards', 'litter', 'air']) gl.addSource(`ss-${id}`, { type: 'geojson', data: empty });
  gl.addLayer({ id: 'ss-air', type: 'circle', source: 'ss-air', paint: { 'circle-radius': 34, 'circle-color': ['get', 'color'], 'circle-opacity': 0.22, 'circle-blur': 0.6, 'circle-pitch-alignment': 'map' } });
  gl.addLayer({
    id: 'ss-hazards', type: 'fill-extrusion', source: 'ss-hazards',
    paint: {
      'fill-extrusion-color': ['get', 'color'],
      'fill-extrusion-height': ['interpolate', ['linear'], ['get', 'sev'], 0, 6, 100, 60],
      'fill-extrusion-opacity': 0.9,
    },
  });
  gl.addLayer({ id: 'ss-litter', type: 'circle', source: 'ss-litter', paint: { 'circle-radius': 7, 'circle-color': '#9C27B0', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
  for (const [layer, kind] of [['ss-hazards', 'hazard'], ['ss-litter', 'litter']]) {
    gl.on('click', layer, (e) => { const no = e.features?.[0]?.properties?.no; if (no) onPick(kind, no); });
    gl.on('mouseenter', layer, () => (gl.getCanvas().style.cursor = 'pointer'));
    gl.on('mouseleave', layer, () => (gl.getCanvas().style.cursor = ''));
  }
}

/** Figma's Gentle spring (stiffness 100, damping 15, mass 1) as an easing for camera moves. */
const GENTLE_S = 0.905;
function gentle(t) {
  const w = 10, z = 0.75, wd = w * Math.sqrt(1 - z * z), s = t * GENTLE_S;
  return t >= 1 ? 1 : 1 - Math.exp(-z * w * s) * (Math.cos(wd * s) + ((z * w) / wd) * Math.sin(wd * s));
}

/** Show the 3D map at the 2D map's position. `center` is [lat, lng]; `zoom` is the Leaflet zoom. */
export async function show3d({ container, center, zoom, data, onPick }) {
  await loadLib();
  const view = { center: [center[1], center[0]], zoom: Math.max(14, zoom - 1), pitch: 0, bearing: 0 };
  const tilt = () => gl.easeTo({ pitch: 60, bearing: -24, duration: 1500, easing: gentle });
  if (!gl) {
    gl = new window.maplibregl.Map({ container, style: STYLE, ...view, antialias: true, attributionControl: { compact: true } });
    gl.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    await new Promise((resolve) => gl.once('load', resolve));
    gl.resize();
    addLayers(onPick);
  } else {
    gl.resize();
    gl.jumpTo(view);
  }
  update3d(data);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) tilt();
  else gl.jumpTo({ pitch: 60, bearing: -24 });
}

export function update3d(data) {
  if (!gl?.getSource('ss-hazards')) return;
  const g = toGeo(data);
  for (const id of ['hazards', 'litter', 'air']) gl.getSource(`ss-${id}`).setData(g[id]);
}

/** You on the 3D map: the same blue dot. */
export function setMe3d(p, html) {
  if (!gl || !window.maplibregl) return;
  if (!me) {
    const el = document.createElement('div');
    el.className = 'me-3d';
    me = new window.maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(gl);
  }
  me.setLngLat([p.lng, p.lat]);
  me.getElement().innerHTML = html;
}

/** Where the 3D camera is, as [lat, lng] and a Leaflet zoom, to hand back to the 2D map. */
export function view3d() {
  if (!gl) return null;
  const c = gl.getCenter();
  return { center: [c.lat, c.lng], zoom: gl.getZoom() + 1 };
}
