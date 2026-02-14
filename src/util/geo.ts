export function degreesToMeters(lat: number, lon: number, refLat: number = lat, refLon: number = lon) {
  // Guard against invalid inputs
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { x: 0, y: 0 };
  const safeRefLat = Number.isFinite(refLat) ? refLat : lat;
  const safeRefLon = Number.isFinite(refLon) ? refLon : lon;
  
  const R = 6371000; // meters
  const dLat = (lat - safeRefLat) * (Math.PI / 180);
  const dLon = (lon - safeRefLon) * (Math.PI / 180);
  const meanLat = ((lat + safeRefLat) / 2) * (Math.PI / 180);
  const x = dLon * R * Math.cos(meanLat);
  const y = dLat * R;
  return { x, y };
}

export function metersToDegrees(x: number, y: number, refLat: number = 0, refLon: number = 0) {
  // Guard against invalid inputs
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { lat: refLat, lon: refLon };
  const safeRefLat = Number.isFinite(refLat) ? refLat : 0;
  const safeRefLon = Number.isFinite(refLon) ? refLon : 0;

  const R = 6371000;
  const dLat = y / R;
  const meanLat = safeRefLat * (Math.PI / 180);
  const dLon = x / (R * Math.cos(meanLat));
  const lat = safeRefLat + (dLat * 180) / Math.PI;
  const lon = safeRefLon + (dLon * 180) / Math.PI;
  
  // Final safety check
  return { 
    lat: Number.isFinite(lat) ? lat : safeRefLat, 
    lon: Number.isFinite(lon) ? lon : safeRefLon 
  };
}

/**
 * Calculate Euclidean distance in meters between two points (x, y).
 */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/**
 * Calculate unit vector direction from source point to target point.
 */
export function directionFromPoints(from: [number, number], to: [number, number]): [number, number] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return null;
  return [dx / mag, dy / mag];
}

/**
 * Computes the centroid (geometric center) of a list of points.
 */
export function computeCentroid(points: [number, number][]): [number, number] {
  if (points.length === 0) return [0, 0];
  let sumX = 0, sumY = 0;
  for (const p of points) {
    sumX += p[0];
    sumY += p[1];
  }
  return [sumX / points.length, sumY / points.length];
}
