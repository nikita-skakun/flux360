import { length, sub } from "./vec2";
import type { Vec2 } from "@/types";

export function calculateOutlierScore<T extends { timestamp: number }>(A: T, B: T, C: T, getGeo: (pt: T) => Vec2) {
  const durationMs = C.timestamp - A.timestamp;
  const duration = durationMs > 0 ? durationMs / 1000 : 0;

  const geoA = getGeo(A);
  const geoB = getGeo(B);
  const geoC = getGeo(C);

  const distAB = length(sub(geoB, geoA));
  const distBC = length(sub(geoC, geoB));
  const distance = distAB + distBC;
  const directDistance = length(sub(geoC, geoA));

  const directSpeed = duration > 0 ? (directDistance / duration) * 3.6 : 0;
  const ratio = distance / Math.max(0.1, directDistance);

  const durationAB = (B.timestamp - A.timestamp) / 1000;
  const durationBC = (C.timestamp - B.timestamp) / 1000;
  const speedAB = durationAB > 0 ? (distAB / durationAB) * 3.6 : 0;
  const speedBC = durationBC > 0 ? (distBC / durationBC) * 3.6 : 0;

  const speed = duration > 0 ? (distance / duration) * 3.6 : 0;

  const liftAB = Math.max(0, speedAB - directSpeed);
  const liftBC = Math.max(0, speedBC - directSpeed);

  const minLift = Math.min(liftAB, liftBC);
  const score = minLift * Math.pow(Math.max(0, ratio - 1), 2);

  return { duration, distance, speed, directSpeed, ratio, score };
}

export function filterMotionOutliers<T extends { timestamp: number }>(
  currentPath: T[],
  previousOutliers: T[] = [],
  getGeo: (pt: T) => Vec2,
  threshold: number = 100
): { cleanPath: T[], newOutliers: T[] } {
  // 1. Combine and sort
  const combined = [...currentPath, ...previousOutliers].sort((a, b) => a.timestamp - b.timestamp);

  if (combined.length < 3) {
    return { cleanPath: combined, newOutliers: [] };
  }

  const cleanPath: T[] = [];
  const startPt = combined[0];
  if (!startPt) return { cleanPath, newOutliers: [] };

  cleanPath.push(startPt);
  const newOutliers: T[] = [];

  // We only check internal points against the currently accepted previous point.
  // This helps handle sequences of outliers better without complex multi-pass logic.
  let A = startPt;

  for (let i = 1; i < combined.length - 1; i++) {
    const B = combined[i];
    const C = combined[i + 1];

    if (!A || !B || !C) continue;

    const { score } = calculateOutlierScore(A, B, C, getGeo);

    if (score > threshold) {
      newOutliers.push(B);
      // We do NOT update A, so the next point is checked against the same valid anchor A
    } else {
      cleanPath.push(B);
      A = B;
    }
  }

  // The last point is never filtered as a midpoint.
  const lastPt = combined[combined.length - 1];
  if (lastPt) cleanPath.push(lastPt);

  return { cleanPath, newOutliers };
}
