import { cosLatitude, fromWebMercator } from "@/util/webMercator";
import type { Bounds, RawGpsCoord, Vec2, WebMercatorCoord } from "@/types";

/** Radius in metres, since variance is metres squared. */
export function getRadiusFromVariance(variance: number): number {
  return Math.sqrt(Math.max(1e-6, variance));
}

const ACCURACY_CIRCLE_SIDES = 64;

/**
 * A circle of a given ground radius, as lng/lat ring coordinates.
 *
 * Mercator stretches distances by sec(latitude), so a ground radius of R metres is
 * R / cos(lat) projected units. Drawing the metre value directly renders a circle
 * smaller than the accuracy it claims by a factor of cos(latitude), which is about a
 * third at temperate latitudes. Scaling here keeps the drawn circle consistent with
 * metricDistance, which is the codebase's metre invariant.
 */
export function buildAccuracyCircleCoords(center: WebMercatorCoord, radiusMeters: number): RawGpsCoord[] {
  const projectedRadius = radiusMeters / Math.max(1e-6, cosLatitude(center[1]));
  return Array.from({ length: ACCURACY_CIRCLE_SIDES + 1 }, (_, index) => {
    const angle = (index * 2 * Math.PI) / ACCURACY_CIRCLE_SIDES;
    return fromWebMercator([
      center[0] + projectedRadius * Math.cos(angle),
      center[1] + projectedRadius * Math.sin(angle),
    ]);
  });
}

export function computeBounds(points: Vec2[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function paddedLngLatBounds(sw: Vec2, ne: Vec2): [Vec2, Vec2] {
  const padding = Math.max(0.001, (ne[0] - sw[0]) * 0.1, (ne[1] - sw[1]) * 0.1);
  return [
    [sw[0] - padding, sw[1] - padding],
    [ne[0] + padding, ne[1] + padding]
  ];
}