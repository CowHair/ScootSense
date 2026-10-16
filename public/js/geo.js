// Best-known rider position: phone GPS if allowed, else the scooter's GPS, else campus.
import { DEFAULT_CENTER } from './ui.js';

let phone = null;
let scooter = null;
let watching = false;

export function setScooterFix(lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) scooter = { lat, lng, at: Date.now() };
}

export function watchPhone() {
  if (watching || !('geolocation' in navigator)) return;
  watching = true;
  navigator.geolocation.watchPosition(
    (p) => { phone = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; },
    () => { watching = false; },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

/** Freshest position, preferring the scooter fix during a ride. */
export function currentPosition() {
  const fresh = (p) => p && Date.now() - p.at < 60_000;
  if (fresh(scooter)) return { ...scooter, source: 'scooter GPS' };
  if (fresh(phone)) return { ...phone, source: 'phone GPS' };
  if (scooter) return { ...scooter, source: 'last scooter fix' };
  return { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1], source: 'approximate (campus)' };
}

export function locateOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Location is not available on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => { phone = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; resolve(phone); },
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}
