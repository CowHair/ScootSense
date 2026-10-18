// Bounded, low-power-first lookup. Never substitutes a default map center for GPS.
export function requestLocation(provider = navigator.geolocation, secure = window.isSecureContext) {
  return new Promise((resolve, reject) => {
    if (!secure) return reject(new Error('Location requires HTTPS or localhost. Open http://localhost:3001 on this computer, or use HTTPS on your phone.'));
    if (!provider) return reject(new Error('This browser does not support location. Enter your starting coordinates instead.'));
    let done = false;
    const finish = (error, position) => {
      if (done) return;
      done = true; clearTimeout(watchdog);
      error ? reject(error) : resolve(position);
    };
    const denied = () => new Error('Location access is blocked. Allow Location for this site in your browser and enable Location Services for your browser in system settings.');
    const unavailable = () => new Error('Your device could not determine its location. Check system Location Services and Wi-Fi, then retry, or enter start coordinates.');
    const watchdog = setTimeout(() => finish(new Error('Location lookup timed out. Check the browser’s location permission and system Location Services, then retry or enter start coordinates.')), 12000);
    const success = p => {
      if (!Number.isFinite(p?.coords?.latitude) || !Number.isFinite(p?.coords?.longitude)) return finish(unavailable());
      finish(null, { lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy, at:Date.now() });
    };
    const firstFailure = error => {
      if (done) return;
      if (error.code === 1) return finish(denied());
      // A second GPS attempt can help when the coarse Wi-Fi position is unavailable.
      try { provider.getCurrentPosition(success, e => finish(e.code === 1 ? denied() : unavailable()), {enableHighAccuracy:true,maximumAge:60000,timeout:6000}); }
      catch { finish(unavailable()); }
    };
    try { provider.getCurrentPosition(success, firstFailure, {enableHighAccuracy:false,maximumAge:60000,timeout:4000}); }
    catch { finish(unavailable()); }
  });
}
