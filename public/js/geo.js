import { requestLocation } from './location-request.js';
import { DEFAULT_CENTER } from './ui.js';

let phone = null;
let scooter = null;
let watching = false;
const listeners = new Set();

export function onPhoneFix(cb) {
  listeners.add(cb);
  if (phone) cb(phone);
  return () => listeners.delete(cb);
}

export function setScooterFix(lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) scooter = { lat, lng, at: Date.now() };
}

export function watchPhone() {
  if (watching || !('geolocation' in navigator)) return;
  watching = true;
  navigator.geolocation.watchPosition(
    (p) => {
      phone = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, at: Date.now() };
      listeners.forEach((cb) => cb(phone));
    },
    (e) => {
      watching = false;
      listeners.forEach((cb) => cb({ error: e.code === 1 ? 'denied' : 'unavailable' }));
    },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

export function currentPosition() {
  const fresh = (p) => p && Date.now() - p.at < 60_000;
  if (fresh(scooter)) return { ...scooter, source: 'scooter GPS' };
  if (fresh(phone)) return { ...phone, source: 'phone GPS' };
  if (scooter) return { ...scooter, source: 'last scooter fix' };
  return { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1], source: 'approximate (campus)' };
}

let locationRequest;
export function locateOnce() {
  if (phone && Date.now() - phone.at < 30000) return Promise.resolve(phone);
  if (!locationRequest) {
    locationRequest = requestLocation().then(position => { phone = position; return phone; }).finally(() => { locationRequest = null; });
  }
  return locationRequest;
}

export function recentPhoneFix(maxAge = 15000) {
  return phone && Date.now() - phone.at <= maxAge ? phone : null;
}
export function rememberPhoneFix(position) {
  if (Number.isFinite(position.coords.latitude) && Number.isFinite(position.coords.longitude)) {
    phone = {lat:position.coords.latitude,lng:position.coords.longitude,acc:position.coords.accuracy,at:position.timestamp};
  }
}
