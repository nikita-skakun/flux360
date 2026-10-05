import { cosLatitude } from "./webMercator";
import type { Vec2 } from "@/types";

export function calculateOutlierScore<T extends { timestamp: number }>(
  A: T, B: T, C: T, getGeo: (pt: T) => Vec2, cosLat: number
) {
  // A, B and C are neighbours, so one scale factor for the whole triple is enough.
  // Deriving it per distance call made the projection maths dominate the score.
  const planarDistance = (p: Vec2, q: Vec2) => {
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    return Math.sqrt(dx * dx + dy * dy) * cosLat;
  };

  const durationMs = C.timestamp - A.timestamp;
  const duration = durationMs > 0 ? durationMs / 1000 : 0;

  const geoA = getGeo(A);
  const geoB = getGeo(B);
  const geoC = getGeo(C);

  // Distances are metric, so the 3.6 below really does produce km/h and the score
  // threshold is not latitude dependent.
  const distAB = planarDistance(geoB, geoA);
  const distBC = planarDistance(geoC, geoB);
  const totalDistance = distAB + distBC;
  const directDistance = planarDistance(geoC, geoA);

  const directSpeed = duration > 0 ? (directDistance / duration) * 3.6 : 0;
  const ratio = totalDistance / Math.max(0.1, directDistance);

  const durationAB = (B.timestamp - A.timestamp) / 1000;
  const durationBC = (C.timestamp - B.timestamp) / 1000;
  const speedAB = durationAB > 0 ? (distAB / durationAB) * 3.6 : 0;
  const speedBC = durationBC > 0 ? (distBC / durationBC) * 3.6 : 0;

  const speed = duration > 0 ? (totalDistance / duration) * 3.6 : 0;

  const liftAB = Math.max(0, speedAB - directSpeed);
  const liftBC = Math.max(0, speedBC - directSpeed);

  const minLift = Math.min(liftAB, liftBC);
  const score = minLift * Math.pow(Math.max(0, ratio - 1), 2);

  return { duration, distance: totalDistance, speed, directSpeed, ratio, score };
}

/**
 * Outlier filter over a timestamp-ordered path.
 *
 * Coordinates are Web Mercator and distances are metric, matching the engine.
 * Each internal point is scored against the last accepted point and its
 * successor, and a rejected point never becomes an anchor for later scoring, so
 * runs of consecutive outliers are all caught. The path arrives already sorted,
 * so this avoids the re-sort and merged copy that made a long motion quadratic
 * on every step. `previousOutliers` is appended to in place and returned.
 */
export function filterMotionOutliers<T extends { timestamp: number }>(
  currentPath: T[],
  previousOutliers: T[] = [],
  getGeo: (pt: T) => Vec2,
  threshold: number = 100
): { cleanPath: T[]; newOutliers: T[] } {
  const n = currentPath.length;
  if (n < 3) return { cleanPath: currentPath, newOutliers: previousOutliers };

  const cleanPath: T[] = [currentPath[0]!];
  const cosLat = cosLatitude(getGeo(currentPath[0]!)[1]);
  let anchorIndex = 0;

  for (let i = 1; i < n - 1; i++) {
    const point = currentPath[i]!;
    const { score } = calculateOutlierScore(currentPath[anchorIndex]!, point, currentPath[i + 1]!, getGeo, cosLat);
    if (score > threshold) {
      previousOutliers.push(point);
      continue;
    }
    cleanPath.push(point);
    anchorIndex = i;
  }

  cleanPath.push(currentPath[n - 1]!);
  return { cleanPath, newOutliers: previousOutliers };
}
