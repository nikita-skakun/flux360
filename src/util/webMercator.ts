import type { Vec2 } from "@/types";

const R = 6378137; // Earth's radius in meters for Web Mercator (EPSG:3857)

/**
 * Convert geographic coordinates (lat/lon in degrees) to Web Mercator (meters).
 * This provides a global, absolute meter-based coordinate system.
 */
export function toWebMercator(lat: number, lon: number): Vec2 {
  const longitudeInRadians = (lon * Math.PI) / 180; // longitude in radians
  const latitudeInRadians = (lat * Math.PI) / 180;  // latitude in radians

  const x = R * longitudeInRadians;
  const y = R * Math.log(Math.tan(Math.PI / 4 + latitudeInRadians / 2));

  return [x, y];
}

/**
 * Convert Web Mercator coordinates (meters) back to geographic (lat/lon in degrees).
 */
export function fromWebMercator(x: number, y: number): { lat: number; lon: number } {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

  return { lat, lon };
}
