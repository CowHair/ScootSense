const cache = new Map();
export function spotAddress(point) {
  const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
  if (!cache.has(key)) cache.set(key, fetch(`/api/spot-address?lat=${point.lat}&lng=${point.lng}`).then(r => r.ok ? r.json() : Promise.reject()).then(r => r.address || 'Address unavailable').catch(() => 'Address unavailable'));
  return cache.get(key);
}
