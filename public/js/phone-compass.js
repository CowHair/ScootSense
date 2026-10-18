export const normalizeHeading = value => ((value % 360) + 360) % 360;
export function smoothHeading(previous, next, strength = .22) {
  if (previous === null) return next;
  const delta = ((next - previous + 540) % 360) - 180;
  return previous + delta * strength;
}
export function compassHeading(event, screenAngle = 0) {
  if (Number.isFinite(event.webkitCompassHeading)) {
    if (Number.isFinite(event.webkitCompassAccuracy) && (event.webkitCompassAccuracy < 0 || event.webkitCompassAccuracy > 45)) return null;
    return normalizeHeading(event.webkitCompassHeading + screenAngle);
  }
  // Relative alpha is not north-referenced and cannot be used as a compass.
  if ((event.absolute === true || event.type === 'deviceorientationabsolute') && Number.isFinite(event.alpha)) return normalizeHeading(360 - event.alpha + screenAngle);
  return null;
}
export async function watchCompass(onHeading) {
  const Orientation = window.DeviceOrientationEvent;
  if (!Orientation) throw Error('Compass unavailable on this device.');
  if (typeof Orientation.requestPermission === 'function') {
    const permission = await Orientation.requestPermission(true);
    if (permission !== 'granted') throw Error('Compass permission denied. Enable Motion & Orientation access to use it.');
  }
  let last = null, lastAbsolute = 0;
  const handler = event => {
    if (event.type === 'deviceorientation' && !Number.isFinite(event.webkitCompassHeading) && Date.now()-lastAbsolute<1000) return;
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    const heading = compassHeading(event, Number(angle) || 0);
    if (heading === null) return;
    if(event.type === 'deviceorientationabsolute')lastAbsolute=Date.now();
    last = smoothHeading(last, heading);
    onHeading(last);
  };
  window.addEventListener('deviceorientationabsolute', handler);
  window.addEventListener('deviceorientation', handler);
  return () => { window.removeEventListener('deviceorientationabsolute',handler);window.removeEventListener('deviceorientation',handler); };
}
