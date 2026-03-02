import { distanceSquared } from "@/util/geo";
import { MOTION_PROFILES } from "./motionDetector";
import { toWebMercator } from "@/util/webMercator";
import type { NormalizedPosition, Vec2, MotionProfileName, Timestamp, RetrospectiveMotionSegment, RetrospectiveResult } from "@/types";

function computePathExtent(points: Vec2[]): number {
  if (points.length < 2) return 0;

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  cx /= points.length;
  cy /= points.length;

  let maxDistSq = 0;
  for (const p of points) {
    const dSq = distanceSquared([cx, cy], p);
    if (dSq > maxDistSq) maxDistSq = dSq;
  }

  return Math.sqrt(maxDistSq) * 2;
}

function toMeterPoint(
  p: NormalizedPosition
): { mean: Vec2; timestamp: Timestamp; accuracy: number } {
  return { mean: toWebMercator(p.geo), timestamp: p.timestamp, accuracy: p.accuracy };
}

function getDynamicRadius(accuracy: number, maxStationaryRadius: number): number {
  // Use a combination of the fixed radius and accuracy-based radius
  // 1.5x accuracy is a common threshold for GPS noise significance
  return Math.max(maxStationaryRadius, accuracy * 0.8);
}

export function analyzeMotion(
  positions: NormalizedPosition[],
  motionProfile: MotionProfileName = "person"
): RetrospectiveResult {
  if (positions.length === 0) {
    return { motionSegments: [] };
  }

  const sorted = [...positions].sort((a, b) => a.timestamp - b.timestamp);
  const profile = MOTION_PROFILES[motionProfile];
  const minStationaryDuration = profile.retrospectiveMinStationaryDuration;
  const maxStationaryRadius = profile.retrospectiveMaxStationaryRadius;

  const meterPoints = sorted.map((p, idx) => ({ ...toMeterPoint(p), index: idx }));
  const len = meterPoints.length;

  type StableInterval = {
    startIndex: number;
    endIndex: number;
    center: Vec2;
    startTime: Timestamp;
    endTime: Timestamp;
    avgAccuracy: number;
  };

  const stableIntervals: StableInterval[] = [];

  let i = 0;
  while (i < len) {
    const startPoint = meterPoints[i]!;
    let j = i + 1;
    let centroidX = startPoint.mean[0];
    let centroidY = startPoint.mean[1];
    let sumAcc = startPoint.accuracy;
    let count = 1;

    while (j < len) {
      const nextPoint = meterPoints[j]!;
      const currentCentroid: Vec2 = [centroidX / count, centroidY / count];
      const dist = distanceSquared(currentCentroid, nextPoint.mean);

      const dynamicRadius = getDynamicRadius(nextPoint.accuracy, maxStationaryRadius);
      const dynamicRadiusSquared = dynamicRadius * dynamicRadius;

      if (dist > dynamicRadiusSquared) {
        // Outlier tolerance: check if subsequent points return to this cluster
        let returned = false;
        if (j + 1 < len) {
          const pNext = meterPoints[j + 1]!;
          const dNext = distanceSquared(currentCentroid, pNext.mean);
          const nextRadius = getDynamicRadius(pNext.accuracy, maxStationaryRadius);
          if (dNext <= nextRadius * nextRadius) {
            returned = true;
          }
        }

        if (!returned) break;
        // If it returned, we treat 'nextPoint' as a noisy point in the stop
      }

      centroidX += nextPoint.mean[0];
      centroidY += nextPoint.mean[1];
      sumAcc += nextPoint.accuracy;
      count++;
      j++;
    }

    const startTime = startPoint.timestamp;
    const endTime = meterPoints[j - 1]!.timestamp;
    const duration = endTime - startTime;
    const isStartOrEnd = (i === 0) || (j === len);
    const isLongEnough = duration >= minStationaryDuration;

    if (isLongEnough || (isStartOrEnd && duration > 0)) {
      stableIntervals.push({
        startIndex: i,
        endIndex: j - 1,
        center: [centroidX / count, centroidY / count],
        startTime,
        endTime,
        avgAccuracy: sumAcc / count
      });
      i = j;
    } else {
      i++;
    }
  }

  const mergedIntervals: StableInterval[] = [];
  if (stableIntervals.length > 0) {
    let current = stableIntervals[0]!;
    for (let k = 1; k < stableIntervals.length; k++) {
      const next = stableIntervals[k]!;
      const dist = distanceSquared(current.center, next.center);

      const pathPointsBetween: Vec2[] = [];
      for (let idx = current.endIndex + 1; idx < next.startIndex; idx++) {
        pathPointsBetween.push(meterPoints[idx]!.mean);
      }
      const midExtent = computePathExtent(pathPointsBetween);

      // Merge if spatially close AND the path between didn't wander too far
      const mergeRadius = Math.max(maxStationaryRadius, (current.avgAccuracy + next.avgAccuracy) * 0.6);
      const mergeRadiusSquared = mergeRadius * mergeRadius;

      if (dist < mergeRadiusSquared && midExtent * midExtent < mergeRadiusSquared) {
        const newCount = (current.endIndex - current.startIndex + 1) + (next.endIndex - next.startIndex + 1);
        const currentSumX = current.center[0] * (current.endIndex - current.startIndex + 1);
        const currentSumY = current.center[1] * (current.endIndex - current.startIndex + 1);
        const nextSumX = next.center[0] * (next.endIndex - next.startIndex + 1);
        const nextSumY = next.center[1] * (next.endIndex - next.startIndex + 1);

        current = {
          startIndex: current.startIndex,
          endIndex: next.endIndex,
          center: [(currentSumX + nextSumX) / newCount, (currentSumY + nextSumY) / newCount],
          startTime: current.startTime,
          endTime: next.endTime,
          avgAccuracy: (current.avgAccuracy + next.avgAccuracy) / 2
        };
      } else {
        mergedIntervals.push(current);
        current = next;
      }
    }
    mergedIntervals.push(current);
  }

  const motionSegments: RetrospectiveMotionSegment[] = [];

  for (let k = 0; k < mergedIntervals.length - 1; k++) {
    const from = mergedIntervals[k]!;
    const to = mergedIntervals[k + 1]!;

    const segmentStartIdx = from.endIndex;
    const segmentEndIdx = to.startIndex;

    if (segmentEndIdx <= segmentStartIdx) continue;

    const pathPoints: Vec2[] = [];
    let sumAcc = 0;
    for (let idx = segmentStartIdx; idx <= segmentEndIdx; idx++) {
      const mp = meterPoints[idx]!;
      pathPoints.push(mp.mean);
      sumAcc += mp.accuracy;
    }

    const avgAcc = sumAcc / pathPoints.length;
    const extent = computePathExtent(pathPoints);

    // Significance check: extent must exceed both fixed radius and accuracy-weighted threshold
    const minExtent = Math.max(maxStationaryRadius, avgAcc * 1.5);
    if (extent < minExtent) continue;

    motionSegments.push({
      startTime: from.endTime,
      endTime: to.startTime,
      startPosition: from.center,
      endPosition: to.center,
      path: [from.center, ...pathPoints, to.center],
      confidence: 1.0,
      distance: extent,
      duration: to.startTime - from.endTime
    });
  }

  if (mergedIntervals.length > 0) {
    const lastInterval = mergedIntervals[mergedIntervals.length - 1]!;
    if (lastInterval.endIndex < len - 1) {
      const pathPoints: Vec2[] = [];
      let sumAcc = 0;
      for (let idx = lastInterval.endIndex; idx < len; idx++) {
        const mp = meterPoints[idx]!;
        pathPoints.push(mp.mean);
        sumAcc += mp.accuracy;
      }

      const avgAcc = sumAcc / pathPoints.length;
      const extent = computePathExtent(pathPoints);
      const minExtent = Math.max(maxStationaryRadius, avgAcc * 1.5);

      if (extent >= minExtent) {
        motionSegments.push({
          startTime: lastInterval.endTime,
          endTime: meterPoints[len - 1]!.timestamp,
          startPosition: lastInterval.center,
          endPosition: meterPoints[len - 1]!.mean,
          path: [lastInterval.center, ...pathPoints],
          confidence: 0.8,
          distance: extent,
          duration: meterPoints[len - 1]!.timestamp - lastInterval.endTime
        });
      }
    }
  } else if (len > 1) {
    const pathPoints = meterPoints.map(p => p.mean);
    let sumAcc = 0;
    for (const mp of meterPoints) sumAcc += mp.accuracy;

    const avgAcc = sumAcc / len;
    const extent = computePathExtent(pathPoints);
    const minExtent = Math.max(maxStationaryRadius, avgAcc * 1.5);

    if (extent >= minExtent) {
      motionSegments.push({
        startTime: meterPoints[0]!.timestamp,
        endTime: meterPoints[len - 1]!.timestamp,
        startPosition: meterPoints[0]!.mean,
        endPosition: meterPoints[len - 1]!.mean,
        path: pathPoints,
        confidence: 0.5,
        distance: extent,
        duration: meterPoints[len - 1]!.timestamp - meterPoints[0]!.timestamp
      });
    }
  }

  return { motionSegments };
}

export function analyzeAllDevices(
  positionsByDevice: Map<number, NormalizedPosition[]>,
  deviceIds: number[],
  motionProfiles: Record<number, MotionProfileName>
): Map<number, RetrospectiveResult> {
  const results = new Map<number, RetrospectiveResult>();

  for (const deviceId of deviceIds) {
    const profile = motionProfiles[deviceId] ?? "person";
    const devicePositions = positionsByDevice.get(deviceId) ?? [];
    const result = analyzeMotion(devicePositions, profile);
    results.set(deviceId, result);
  }

  return results;
}
