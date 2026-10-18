// Coordinate order must be selected explicitly; local XYZ cannot be mapped as GPS.
export function mapFlaskSpots(spots, order) {
  if (!['lat-lng', 'lng-lat'].includes(order)) return { spots: [], skipped: spots.length };
  const mapped = [];
  for (const [index, spot] of spots.entries()) {
    const c = spot?.coord;
    if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const [lat, lng] = order === 'lat-lng' ? c : [c[1], c[0]];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    mapped.push({ id: String(spot.id ?? index), source: 'tiger_spots', lat, lng, type: String(spot.type || 'Unspecified'), count: Number.isFinite(spot.count) ? spot.count : 0 });
  }
  return { spots: mapped, skipped: spots.length - mapped.length };
}

// Search accepts latitude, longitude, and an optional altitude (ignored by a 2D map).
export function parseMapCoordinates(text) {
  const value = text.trim();
  if (!/^[\[\]\s,+.\-\d]+$/.test(value)) return null;
  const parts = value.replace(/^\[|\]$/g, '').trim().split(/[,\s]+/).filter(Boolean);
  if (parts.length < 2) return { error: 'Enter latitude and longitude, for example 43.7843, -79.1885.' };
  const numbers = parts.map(Number);
  if (numbers.length > 3 || !numbers.every(Number.isFinite) || Math.abs(numbers[0]) > 90 || Math.abs(numbers[1]) > 180) {
    return { error: 'Latitude must be between -90 and 90; longitude between -180 and 180.' };
  }
  return { lat: numbers[0], lng: numbers[1] };
}
