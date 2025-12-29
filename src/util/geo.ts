export function degreesToMeters(lat: number, lon: number, refLat: number = lat, refLon: number = lon) {
  const R = 6371000; // meters
  const dLat = (lat - refLat) * (Math.PI / 180);
  const dLon = (lon - refLon) * (Math.PI / 180);
  const meanLat = ((lat + refLat) / 2) * (Math.PI / 180);
  const x = dLon * R * Math.cos(meanLat);
  const y = dLat * R;
  return { x, y };
}

export function metersToDegrees(x: number, y: number, refLat: number = 0, refLon: number = 0) {
  const R = 6371000;
  const dLat = y / R;
  const meanLat = refLat * (Math.PI / 180);
  const dLon = x / (R * Math.cos(meanLat));
  const lat = refLat + (dLat * 180) / Math.PI;
  const lon = refLon + (dLon * 180) / Math.PI;
  return { lat, lon };
}
