import type { Vec2 } from "@/types";

export const WORLD_R = 6378137; // Earth's radius in meters for Web Mercator (EPSG:3857)

/**
 * Convert geographic coordinates (lat/lon in degrees) to Web Mercator (meters).
 * This provides a global, absolute meter-based coordinate system.
 */
export function toWebMercator(v: Vec2): Vec2 {
  const [lon, lat] = v;
  const longitudeInRadians = (lon * Math.PI) / 180; // longitude in radians
  const latitudeInRadians = (lat * Math.PI) / 180;  // latitude in radians

  const x = WORLD_R * longitudeInRadians;
  const y = WORLD_R * Math.log(Math.tan(Math.PI / 4 + latitudeInRadians / 2));

  return [x, y];
}

/**
 * Convert Web Mercator coordinates (meters) back to geographic (lat/lon in degrees).
 */
export function fromWebMercator(v: Vec2): Vec2 {
  const [x, y] = v;
  const lon = (x / WORLD_R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / WORLD_R)) - Math.PI / 2) * (180 / Math.PI);

  return [lon, lat];
}
