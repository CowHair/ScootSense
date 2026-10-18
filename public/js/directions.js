import { VoiceGuidance } from './voice-guidance.js';
const voice = new VoiceGuidance();
import { watchCompass } from './phone-compass.js';
import { distance, bearing, routeProgress } from './navigation-geometry.js';
import { celebrateCollection } from './collection-feedback.js';
import { $, esc, api, toast } from './ui.js';
import { parseMapCoordinates } from './spot-coordinates.js';
import { spotAddress } from './spot-address.js';
import { locateOnce, recentPhoneFix, rememberPhoneFix } from './geo.js';
let map, group, destination, destinationName, request;
let navigation = null, navigationGeneration = 0, routeGeometry = null, lastRouteAt = 0, routeDuration = 0, routeDistance = 0;
let mode = 'walking', getTrash = () => [], selectionVersion = 0;
export function initDirections(leafletMap, trashSource) {
  getTrash = trashSource || getTrash;
  map = leafletMap; group = L.layerGroup().addTo(map);
  document.body.appendChild($('#route-embed'));
  map.createPane('navigationRoute');
  map.getPane('navigationRoute').style.zIndex = 450;
  map.getPane('navigationRoute').style.pointerEvents = 'none';
  voice.prepare();
  const voiceButton=$('#navigation-voice');
  if(!voice.supported()){voiceButton.disabled=true;voiceButton.title='Voice guidance is unavailable in this browser';}
  voiceButton.onclick=()=>{
    const enabled=voice.toggle();voiceButton.setAttribute('aria-pressed',String(enabled));
    voiceButton.querySelector('span').textContent=enabled?'Voice on':'Voice off';
    voiceButton.querySelector('i').textContent=enabled?'volume_up':'volume_off';
    if(enabled)announceCurrentTurn();
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden)voice.cancel();});
  $('#navigation-start').onclick = () => navigation ? stopNavigation('Live navigation stopped.') : startNavigation();
  $('#navigation-follow').onclick = () => { if(navigation){ navigation.follow=true; if(navigation.point) map.panTo(navigation.point); } };
  map.on('dragstart',()=>{if(navigation){navigation.follow=false;$('#navigation-follow').classList.remove('hidden');}});
  window.addEventListener('pagehide',()=>stopNavigation());
  initRouteSheet();
  $('#route-sort').onchange = renderTrash;
  $('#route-nearest').onclick = async () => { if (await ensureOrigin()) { const items = sortedTrash(); if (items.length) selectTrash(items[0].point); else $('#route-status').textContent = 'No mapped trash available. Check the saved coordinate order.'; } };
  window.addEventListener('map-trash-updated', renderTrash);
  window.addEventListener('route-trash-selected', e => selectTrash(e.detail));
  $('#route-origin').onchange = () => { renderTrash(); updateStartAddress(); if(destination)calculate(); };
  $('#route-close').onclick = closeDirections;
  $('#route-form').onsubmit = e => { e.preventDefault(); calculate(); };
  $('#route-location').onclick = async () => {
    const version = selectionVersion;
    const button = $('#route-location');
    button.disabled = true; button.textContent = 'Locating…';
    $('#route-status').textContent = 'Getting your location… Allow the browser’s location prompt if it appears.';
    try { const p = await locateOnce(); if(version !== selectionVersion) return false; $('#route-origin').value = `${p.lat}, ${p.lng}`; $('#route-status').textContent = 'Start location ready. Updating route…'; renderTrash(); updateStartAddress(); if(destination)calculate(); }
    catch (e) { if(version === selectionVersion) $('#route-status').textContent = e.message; }
    finally { button.disabled = false; button.textContent = 'Use my location'; }
  };
  document.querySelectorAll('[data-route-mode]').forEach(button => button.onclick = () => {
    stopNavigation(); routeGeometry=null;
    mode = button.dataset.routeMode;
    document.querySelectorAll('[data-route-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    request?.abort(); group.clearLayers(); $('#route-steps').replaceChildren(); $('#route-embed').classList.add('hidden'); $('#route-embed').removeAttribute('src');
    $('#route-status').textContent = 'Updating route…';
    const origin = parseMapCoordinates($('#route-origin').value);
    if (origin && !origin.error && destination) calculate();
  });
  window.addEventListener('hashchange', () => { if (location.hash !== '#map') closeDirections(); });
}
export function openDirections(point, name = 'Selected location') {
  window.dispatchEvent(new Event('route-opening'));
  stopNavigation(); routeGeometry=null;
  request?.abort(); group.clearLayers(); $('#route-steps').replaceChildren();
  $('#route-embed').removeAttribute('src'); $('#route-embed').classList.add('hidden');
  destination = [point.lat, point.lng]; destinationName = name;
  const kind=point.source;
  const isPickup=['tiger_spots','litter'].includes(kind);
  const actionLabel=kind==='hazard'?'✓ Mark as fixed':kind==='air'?'✓ Mark as resolved':'✓ Mark as collected';
  const details=$('#route-details');
  const mapKind=point.mapKind || (kind==='tiger_spots'?'flask':kind==='litter'?'litter':null);
  details.classList.toggle('hidden',!mapKind);
  details.onclick=()=>window.dispatchEvent(new CustomEvent('route-details',{detail:{kind:mapKind,id:point.mapId||point.no||point.id}}));
  const complete=$('#route-complete');
  complete.classList.toggle('hidden',!['tiger_spots','litter','hazard'].includes(kind));
  delete complete.dataset.collected; complete.disabled=false;complete.textContent=actionLabel;
  complete.onclick=async()=>{
    complete.disabled=true;complete.textContent='Saving…';
    const [endpoint,body]=kind==='tiger_spots'?[`/api/spots/${encodeURIComponent(point.id)}/collect`,{}]
      :kind==='litter'?[`/api/litter/${encodeURIComponent(point.no)}/check`,{answer:'picked'}]
      :[`/api/hazards/${encodeURIComponent(point.no)}/vote`,{vote:'fixed'}];
    try {
      await api(endpoint,{method:'POST',body});
      complete.textContent=isPickup?'✓ Collected':'✓ Resolved';
      await celebrateCollection(complete);closeDirections();
      window.dispatchEvent(new Event('map-item-completed'));
      window.dispatchEvent(new Event('data-changed'));window.dispatchEvent(new Event('trash-changed'));
      toast(isPickup?'Collected! +1 litter item added to your account.':'Thanks, marked as fixed.','ok');
    } catch(error){toast(error.message,'err');complete.disabled=false;complete.textContent=actionLabel;}
  };
  setRouteSheet('medium');
  $('#route-panel').classList.remove('hidden'); document.body.classList.add('route-open');
  $('#route-place-name').textContent = name === 'Map center' ? 'Selected location' : name;
  $('#route-place-address').textContent = 'Finding address…';
  $('#route-coordinate-value').textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
  $('#route-coordinate-value').closest('details').open = false;
  const version = ++selectionVersion;
  spotAddress(point).then(address => {
    if (version !== selectionVersion) return;
    const parts = address.split(',').map(s => s.trim());
    const hasPlaceName = parts.length > 1 && !/^\d/.test(parts[0]) && address !== 'Address unavailable';
    $('#route-place-name').textContent = hasPlaceName ? parts[0] : name;
    $('#route-place-address').textContent = hasPlaceName ? parts.slice(1).join(', ') : address;
  });
  renderTrash();
  $('#route-status').textContent = 'Choose a starting point and travel mode.';
  $('#map-sheet').classList.remove('expanded');
  updateStartAddress();
  // A destination selection is the route action; no extra submit is required.
  ensureOrigin().then(ok => { if(ok && selectionVersion===version && !$('#route-panel').classList.contains('hidden')) calculate(); });
}
export function closeDirections() {
  ++selectionVersion;
  stopNavigation(); routeGeometry=null;
  request?.abort(); group?.clearLayers(); $('#route-panel').classList.add('hidden'); document.body.classList.remove('route-open');
  $('#route-embed').removeAttribute('src'); $('#route-embed').classList.add('hidden');
}
async function calculate(live = false) {
  const origin = parseMapCoordinates($('#route-origin').value);
  if (!origin || origin.error) { $('#route-origin').closest('details').open = true; $('#route-status').textContent = origin?.error || 'Enter start latitude, longitude, or use your location.'; return; }
  request?.abort();
  if (!live) { group.clearLayers(); $('#route-steps').replaceChildren(); routeGeometry=null; }
  if (mode === 'transit') {
    $('#route-status').textContent = 'In-app bus and train routes need a transit routing provider. Choose Walk, Cycle or Drive for a route on this map.';
    return;
  }
  request = new AbortController();
  const current = request;
  $('#route-form').setAttribute('aria-busy','true');
  $('#route-status').textContent = 'Finding your route…';
  try {
    const response = await fetch('/api/directions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: current.signal,
      body: JSON.stringify({ origin: [origin.lat, origin.lng], destination, mode }),
    });
    const route = await response.json();
    if (!response.ok) throw Error(route.error || 'Could not find a route.');
    if (request !== current) return;
    group.clearLayers();
    voice.setRoute(route.steps,route.distance);
    routeGeometry=route.geometry.coordinates; routeDuration=route.duration; routeDistance=route.distance; lastRouteAt=Date.now();
    announceCurrentTurn();
    L.geoJSON(route.geometry, { pane: 'navigationRoute', style: { color: '#fff', weight: 10, opacity: .95 } }).addTo(group);
    const line = L.geoJSON(route.geometry, { pane: 'navigationRoute', style: { color: '#12b8a6', weight: 6, opacity: 1, lineCap: 'round' } }).addTo(group);
    L.circleMarker([origin.lat, origin.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#12b8a6', fillOpacity: 1 }).bindTooltip('Start').addTo(group);
    L.marker(destination).bindTooltip(destinationName).addTo(group);
    $('#route-origin').blur(); map.invalidateSize();
    const panel = $('#route-panel').getBoundingClientRect();
    if (!live) map.fitBounds(line.getBounds(), innerWidth <= 700
      ? { paddingTopLeft: [30, 75], paddingBottomRight: [30, Math.min(panel.height + 30, map.getSize().y * .6)] }
      : { paddingTopLeft: [370, 80], paddingBottomRight: [50, 50] });
    $('#route-status').innerHTML = `<strong class="route-duration">${Math.max(1, Math.round(route.duration / 60))} min</strong><span class="route-distance">${(route.distance / 1000).toFixed(1)} km · ${esc(mode)}</span><small>Estimated travel time · no live traffic</small>`;
    $('#route-steps').innerHTML = route.steps.map(step => `<li><span>${esc(step.type.replaceAll('_', ' '))}${step.modifier ? ` ${esc(step.modifier)}` : ''}${step.name ? ` onto ${esc(step.name)}` : ''}</span><small>${Math.round(step.distance)} m</small></li>`).join('');
  } catch (error) {
    if (error.name !== 'AbortError' && current === request) $('#route-status').textContent = error.message;
  } finally { if (current === request) $('#route-form').removeAttribute('aria-busy'); }
}

async function ensureOrigin() {
  const version = selectionVersion;
  const start = parseMapCoordinates($('#route-origin').value);
  if (start && !start.error) return true;
  $('#route-status').textContent = 'Getting your location to find nearby trash…';
  try { const p = await locateOnce(); if(version !== selectionVersion) return false; $('#route-origin').value = `${p.lat}, ${p.lng}`; renderTrash(); updateStartAddress(); return true; }
  catch (e) { if(version !== selectionVersion) return false; const entered = parseMapCoordinates($('#route-origin').value); if(entered && !entered.error) return true; $('#route-origin').closest('details').open = true; $('#route-status').textContent = e.message + '. Enter your starting coordinates to draw the route.'; return false; }
}
function sortedTrash() {
  const origin = parseMapCoordinates($('#route-origin').value);
  if (!origin || origin.error) return [];
  return getTrash().map(point => ({ point, distance: map.distance([origin.lat, origin.lng], [point.lat, point.lng]) })).sort((a,b) => a.distance - b.distance);
}
function selectTrash(point) {
  openDirections(point, point.type || 'Trash spot');
}
function renderTrash() {
  const list = $('#route-trash-list');
  if (!list) return;
  const items = sortedTrash();
  if (!items.length) { list.textContent = 'Set your start location to see nearby trash.'; return; }
  const ordered = $('#route-sort').value === 'desc' ? [...items].reverse() : items;
  list.replaceChildren();
  ordered.slice(0, 20).forEach(({point, distance}) => {
    const article = document.createElement('article'); article.className = 'route-trash-item';
    article.innerHTML = `<button type="button" class="route-trash-select"><i class="material-icons" aria-hidden="true">delete_outline</i><span><b>${esc(point.type || 'Trash spot')}</b><small class="trash-address">View address</small></span><strong>${distance < 1000 ? Math.round(distance) + ' m' : (distance/1000).toFixed(1) + ' km'}</strong><i class="material-icons" aria-hidden="true">arrow_forward</i></button><details><summary>Coordinates</summary>${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}</details>`;
    article.querySelector('button').onclick = () => selectTrash(point);
    // Resolve visible results only after the user opens the directions panel.
    if (!$('#route-panel').classList.contains('hidden')) spotAddress(point).then(address => { article.querySelector('.trash-address').textContent = address; });
    list.append(article);
  });
}

async function updateStartAddress() {
  const p = parseMapCoordinates($('#route-origin').value);
  if (!p || p.error) { $('#route-start-address').textContent = 'Choose your starting location'; return; }
  const value = $('#route-origin').value;
  $('#route-start-address').textContent = 'Finding start address…';
  const address = await spotAddress(p);
  if ($('#route-origin').value === value) $('#route-start-address').textContent = address;
}

function stopNavigation(message='') {
  voice.cancel();
  ++navigationGeneration;
  if(navigation){request?.abort(); navigator.geolocation.clearWatch(navigation.watch);clearTimeout(navigation.timer);navigation.compassCleanup?.(); cancelAnimationFrame(navigation.compassFrame); navigation.layers.remove();navigation=null;}
  $('#navigation-start').textContent='Start live navigation';
  $('#navigation-follow').classList.add('hidden');
  $('#navigation-status').textContent=message;
  $('#navigation-compass').textContent='';
  $('#navigation-upcoming').classList.add('hidden');
}
function startNavigation() {
  if(!window.isSecureContext || !navigator.geolocation){$('#navigation-status').textContent='Live location requires HTTPS. Open the public HTTPS link and allow location access.';return;}
  if(mode==='transit'){$('#navigation-status').textContent='Choose Walk, Cycle or Drive first.';return;}
  stopNavigation();
  // Keep the route already displayed; do not force a network request at startup.
  const generation=++navigationGeneration;
  const layers=L.layerGroup().addTo(map);
  navigation={layers,watch:null,follow:true,point:null,previous:null,offCount:0,lastFix:Date.now(),rerouting:false};
  $('#navigation-start').textContent='Stop navigation';
  if(innerWidth<=700)setRouteSheet('collapsed');
  $('#navigation-follow').classList.remove('hidden');
  $('#navigation-status').textContent='Navigation on · getting your position…';
  voice.announced.clear();
  // The next-turn prompt is more useful than a generic startup message.
  voice.prepare();
  const session=navigation;
  $('#navigation-compass').textContent='Hold your phone fairly flat for the compass.';
  // Called directly from the Start button so iOS can show its permission prompt.
  watchCompass(heading => {
    if(navigation!==session)return;
    session.compassHeading=heading;session.compassAt=Date.now();
    if(!session.compassFrame)session.compassFrame=requestAnimationFrame(()=>{
      session.compassFrame=null;
      if(navigation!==session)return;
      const icon=session.marker?.getElement();
      if(icon){icon.classList.add('has-heading');icon.style.setProperty('--heading',`${session.compassHeading}deg`);}
    });
    if(!session.compassShown){session.compassShown=true;$('#navigation-compass').textContent='Phone compass active · hold your phone fairly flat';}
  }).then(cleanup=>{if(navigation===session)session.compassCleanup=cleanup;else cleanup();})
    .catch(error=>{if(navigation===session)$('#navigation-compass').textContent=error.message+' Direction will use movement when available.';});
  session.timer=setInterval(()=>{if(navigation===session && Date.now()-session.lastFix>20000)$('#navigation-status').textContent='Location signal is stale. Waiting for a fresh GPS position…';},5000);
  const receivePosition = async position=>{
    if(generation!==navigationGeneration || navigation!==session)return;
    const c=position.coords,point=[c.latitude,c.longitude];
    if(!point.every(Number.isFinite)||Date.now()-position.timestamp>15000)return;
    if(session.fixTimestamp && position.timestamp < session.fixTimestamp)return;
    session.fixTimestamp=position.timestamp;
    rememberPhoneFix(position);
    session.lastFix=Date.now(); session.point=point; session.accuracy=c.accuracy;
    const accuracy=Number.isFinite(c.accuracy)?c.accuracy:1000;
    const compassFresh = session.compassAt && Date.now()-session.compassAt < 5000;
    let heading=compassFresh ? session.compassHeading : (Number.isFinite(c.heading) && c.speed > .8 ? c.heading : null);
    if(heading===null&&session.previous&&distance(session.previous,point)>Math.max(4,accuracy*.5))heading=bearing(session.previous,point);
    if(!session.previous||distance(session.previous,point)>4)session.previous=point;
    if(!session.marker){
      if(session.follow) map.setView(point,17,{animate:false});
      session.circle=L.circle(point,{radius:accuracy,color:'#3982e5',weight:1,fillOpacity:.08,interactive:false}).addTo(layers);
      session.marker=L.marker(point,{icon:L.divIcon({className:'live-position-icon',iconSize:[32,32],iconAnchor:[16,16],html:'<svg class="live-position-arrow" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 28 28 16 22 4 28Z"/></svg>'}),zIndexOffset:1500}).addTo(layers);
    }
    session.marker.setLatLng(point);session.circle.setLatLng(point).setRadius(accuracy);
    const icon=session.marker.getElement();
    if(icon){icon.classList.toggle('has-heading',heading!==null);icon.style.setProperty('--heading',`${heading||0}deg`);}
    // Avoid restarting an animated pan for every GPS callback.
    if(session.follow && (!session.lastPan || (Date.now()-session.lastPanAt>700 && distance(session.lastPan,point)>2))){
      map.panTo(point,{animate:false});session.lastPan=point;session.lastPanAt=Date.now();
    }
    if(accuracy>80){$('#navigation-status').textContent=`GPS accuracy is low (±${Math.round(accuracy)} m). Waiting before rerouting.`;return;}
    const progress=routeGeometry?routeProgress(point,routeGeometry):null;
    const arrival=distance(point,destination);
    if(arrival<=20&&accuracy<=25){stopNavigation('You’ve arrived near your destination.');voice.say('You have arrived near your destination.');return;}
    if(progress){
      if(progress.offRoute<=Math.max(35,accuracy*1.5)) {
        voice.update(progress.remaining,mode);
        const next=voice.nextInstruction(progress.remaining);
        $('#navigation-upcoming').classList.toggle('hidden',!next);
        if(next){
          const label=next.metres<=12?'Now':`In ${Math.max(10,Math.round(next.metres/10)*10)} m`;
          if($('#navigation-turn-distance').textContent!==label)$('#navigation-turn-distance').textContent=label;
          if($('#navigation-turn-text').textContent!==next.text)$('#navigation-turn-text').textContent=next.text;
          $('#navigation-upcoming i').textContent=next.modifier?.includes('left')?'turn_left':next.modifier?.includes('right')?'turn_right':next.modifier==='uturn'?'u_turn_left':next.type==='roundabout'?'roundabout_right':'straight';
        }
      } else $('#navigation-upcoming').classList.add('hidden');
      const minutes=routeDistance?Math.max(1,Math.round(progress.remaining/routeDistance*routeDuration/60)):1;
      $('#navigation-status').textContent=`Live · ${Math.round(progress.remaining)} m remaining · about ${minutes} min · GPS ±${Math.round(accuracy)} m${heading===null?' · Waiting for compass or movement':''}`;
      session.offCount=progress.offRoute>Math.max(35,accuracy*1.5)?session.offCount+1:0;
    }
    if(!session.rerouting&&(!session.routeAttemptAt||Date.now()-session.routeAttemptAt>5000)&&(!routeGeometry||(Date.now()-lastRouteAt>20000&&session.offCount>=3))){
      voice.say('Updating your route.');
      session.rerouting=true;session.routeAttemptAt=Date.now();lastRouteAt=Date.now();
      $('#route-origin').value=`${point[0]}, ${point[1]}`;
      $('#navigation-status').textContent='Updating route from your live location…';
      try{await calculate(true);}finally{session.rerouting=false;}
    }
  };
  const locationError = error=>{
    if(generation!==navigationGeneration)return;
    if(error.code===1)stopNavigation('Location permission denied. Allow location access in browser settings to navigate.');
    else $('#navigation-status').textContent='GPS is unavailable. Waiting for your location…';
  };
  const cached=recentPhoneFix();
  if(cached)receivePosition({coords:{latitude:cached.lat,longitude:cached.lng,accuracy:cached.acc ?? cached.accuracy},timestamp:cached.at});
  if(navigation!==session)return;
  session.watch=navigator.geolocation.watchPosition(receivePosition,locationError,{enableHighAccuracy:true,maximumAge:10000,timeout:12000});
  // Race a fast cached/network fix against the slower high-accuracy GPS start.
  navigator.geolocation.getCurrentPosition(receivePosition,()=>{},{enableHighAccuracy:false,maximumAge:10000,timeout:1800});
}


function announceCurrentTurn() {
  if(!navigation?.point || !routeGeometry || navigation.accuracy>80 || Date.now()-navigation.lastFix>15000)return;
  const progress=routeProgress(navigation.point,routeGeometry);
  if(progress.offRoute<=Math.max(35,(navigation.accuracy||0)*1.5))voice.update(progress.remaining,mode);
}

function setRouteSheet(state) {
  const panel=$('#route-panel');
  panel.dataset.sheet=state;panel.style.removeProperty('height');panel.style.removeProperty('--drag-height');
  const expanded=state!=='collapsed';
  $('#route-sheet-handle').setAttribute('aria-expanded',String(expanded));
  $('#route-sheet-handle').setAttribute('aria-label',expanded?'Collapse directions panel':'Expand directions panel');
  if(innerWidth<=700)$('#route-sheet-content').inert=!expanded;
}
function initRouteSheet() {
  const handle=$('#route-sheet-handle'),panel=$('#route-panel');
  let drag=null;
  handle.onclick=()=>{if(!handle.dataset.dragged)setRouteSheet(panel.dataset.sheet==='collapsed'?'medium':'collapsed');delete handle.dataset.dragged;};
  handle.onpointerdown=event=>{
    if(innerWidth>700)return;
    drag={y:event.clientY,height:panel.getBoundingClientRect().height};
    handle.setPointerCapture(event.pointerId);panel.classList.add('sheet-dragging');
  };
  handle.onpointermove=event=>{
    if(!drag)return;
    const delta=drag.y-event.clientY;
    if(Math.abs(delta)>8)handle.dataset.dragged='true';
    panel.style.setProperty('--drag-height',`${Math.max(170,Math.min(innerHeight*.82,drag.height+delta))}px`);
  };
  const end=()=>{
    if(!drag)return;
    const height=panel.getBoundingClientRect().height;
    drag=null;panel.classList.remove('sheet-dragging');
    setRouteSheet(height<innerHeight*.34?'collapsed':height>innerHeight*.64?'expanded':'medium');
  };
  handle.onpointerup=end;handle.onpointercancel=end;
  window.addEventListener('resize',()=>{if(innerWidth>700)$('#route-sheet-content').inert=false;else $('#route-sheet-content').inert=panel.dataset.sheet==='collapsed';});
}
