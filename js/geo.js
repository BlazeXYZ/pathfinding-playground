const R = 6371008.8; // mean Earth radius in meters
const RAD = Math.PI / 180;

// Great-circle distance in meters.
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Web Mercator, normalised to [0, 1] on both axes (multiply by the CRS scale to get pixels).
export function mercatorX(lon) {
  return (lon + 180) / 360;
}

export function mercatorY(lat) {
  const s = Math.sin(lat * RAD);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function formatDistance(m) {
  if (!isFinite(m)) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function formatDuration(s) {
  if (!isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return min < 60 ? `${min} min ${sec} s` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
