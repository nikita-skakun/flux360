import { asRawGpsCoord, asWebMercatorCoord } from "@/types";
import type { Vec2, RawGpsCoord, WebMercatorCoord } from "@/types";

const WORLD_R = 6378137; // Earth's radius in meters for Web Mercator (EPSG:3857)

/**
 * Convert geographic coordinates (lat/lon in degrees) to Web Mercator (meters).
 * This provides a global, absolute meter-based coordinate system.
 */
export function toWebMercator(v: Vec2): WebMercatorCoord {
  const [lon, lat] = v;
  const longitudeInRadians = (lon * Math.PI) / 180; // longitude in radians
  const latitudeInRadians = (lat * Math.PI) / 180;  // latitude in radians

  const x = WORLD_R * longitudeInRadians;
  const y = WORLD_R * Math.log(Math.tan(Math.PI / 4 + latitudeInRadians / 2));

  return asWebMercatorCoord([x, y]);
}

/**
 * Local scale factor of the projection. Web Mercator is conformal, so a ground
 * distance of d maps to d / cos(lat) on the plane at every bearing.
 */
export function cosLatitude(y: number): number {
  return Math.cos((2 * Math.atan(Math.exp(y / WORLD_R)) - Math.PI / 2));
}

/**
 * Ground distance in metres between two Web Mercator points. Use this for every
 * distance that is compared against a metre threshold.
 */
export function metricDistance(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy) * cosLatitude(a[1]);
}

/**
 * Convert Web Mercator coordinates (meters) back to geographic (lat/lon in degrees).
 */
export function fromWebMercator(v: Vec2): RawGpsCoord {
  const [x, y] = v;
  const lon = (x / WORLD_R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / WORLD_R)) - Math.PI / 2) * (180 / Math.PI);

  return asRawGpsCoord([lon, lat]);
}
