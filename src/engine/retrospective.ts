import { degreesToMeters } from "@/util/geo";
import type { NormalizedPosition, Vec2, MotionProfileName } from "@/types";
import { MOTION_PROFILES } from "./motionDetector";

export type RetrospectiveMotionSegment = {
  startTime: number;
  endTime: number;
  startPosition: Vec2;
  endPosition: Vec2;
  path: Vec2[];
  confidence: number;
};

export type RetrospectiveResult = {
  motionSegments: RetrospectiveMotionSegment[];
};

function distanceMeters(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

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
  
  let maxDist = 0;
  for (const p of points) {
    const d = distanceMeters([cx, cy], p);
    if (d > maxDist) maxDist = d;
  }
  
  return maxDist * 2;
}

function toMeterPoint(
  p: NormalizedPosition,
  refLat: number,
  refLon: number
): { mean: Vec2; timestamp: number; accuracy: number } {
  const { x, y } = degreesToMeters(p.lat, p.lon, refLat, refLon);
  return { mean: [x, y], timestamp: p.timestamp, accuracy: p.accuracy };
}

export function analyzeMotion(
  positions: NormalizedPosition[],
  refLat: number,
  refLon: number,
  motionProfile: MotionProfileName = "person"
): RetrospectiveResult {
  if (positions.length === 0) {
    return { motionSegments: [] };
  }

  const sorted = [...positions].sort((a, b) => a.timestamp - b.timestamp);
  const profile = MOTION_PROFILES[motionProfile];
  const minStationaryDuration = profile.retrospectiveMinStationaryDuration;
  const maxStationaryRadius = profile.retrospectiveMaxStationaryRadius;
  
  const meterPoints = sorted.map((p, idx) => ({ ...toMeterPoint(p, refLat, refLon), index: idx }));
  const len = meterPoints.length;
  
  type StableInterval = {
    startIndex: number;
    endIndex: number;
    center: Vec2;
    startTime: number;
    endTime: number;
  };
  
  const stableIntervals: StableInterval[] = [];
  
  let i = 0;
  while (i < len) {
    const startPoint = meterPoints[i]!;
    let j = i + 1;
    let centroidX = startPoint.mean[0];
    let centroidY = startPoint.mean[1];
    let count = 1;
    
    while (j < len) {
      const nextPoint = meterPoints[j]!;
      const dist = distanceMeters([centroidX / count, centroidY / count], nextPoint.mean);
      if (dist > maxStationaryRadius) break;
      centroidX += nextPoint.mean[0];
      centroidY += nextPoint.mean[1];
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
        endTime
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
      const dist = distanceMeters(current.center, next.center);
      const timeGap = next.startTime - current.endTime;
      
      if (dist < maxStationaryRadius && timeGap < 30000) {
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
          endTime: next.endTime
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
    for (let idx = segmentStartIdx; idx <= segmentEndIdx; idx++) {
      pathPoints.push(meterPoints[idx]!.mean);
    }
    
    const extent = computePathExtent(pathPoints);
    if (extent < maxStationaryRadius) continue;
    
    motionSegments.push({
      startTime: from.endTime,
      endTime: to.startTime,
      startPosition: from.center,
      endPosition: to.center,
      path: [from.center, ...pathPoints, to.center],
      confidence: 1.0
    });
  }
  
  if (mergedIntervals.length > 0) {
    const lastInterval = mergedIntervals[mergedIntervals.length - 1]!;
    if (lastInterval.endIndex < len - 1) {
      const pathPoints: Vec2[] = [];
      for (let idx = lastInterval.endIndex; idx < len; idx++) {
        pathPoints.push(meterPoints[idx]!.mean);
      }
      
      const extent = computePathExtent(pathPoints);
      if (extent >= maxStationaryRadius) {
        motionSegments.push({
          startTime: lastInterval.endTime,
          endTime: meterPoints[len - 1]!.timestamp,
          startPosition: lastInterval.center,
          endPosition: meterPoints[len - 1]!.mean,
          path: [lastInterval.center, ...pathPoints],
          confidence: 0.8
        });
      }
    }
  } else if (len > 1) {
    const pathPoints = meterPoints.map(p => p.mean);
    const extent = computePathExtent(pathPoints);
    if (extent >= maxStationaryRadius) {
      motionSegments.push({
        startTime: meterPoints[0]!.timestamp,
        endTime: meterPoints[len - 1]!.timestamp,
        startPosition: meterPoints[0]!.mean,
        endPosition: meterPoints[len - 1]!.mean,
        path: pathPoints,
        confidence: 0.5
      });
    }
  }
  
  return { motionSegments };
}

export function analyzeAllDevices(
  positions: NormalizedPosition[],
  deviceIds: number[],
  refLat: number,
  refLon: number,
  motionProfiles: Record<number, MotionProfileName>
): Map<number, RetrospectiveResult> {
  const results = new Map<number, RetrospectiveResult>();
  const positionsByDevice = new Map<number, NormalizedPosition[]>();
  
  for (const p of positions) {
    if (!positionsByDevice.has(p.device)) {
      positionsByDevice.set(p.device, []);
    }
    positionsByDevice.get(p.device)!.push(p);
  }

  for (const deviceId of deviceIds) {
    const profile = motionProfiles[deviceId] ?? "person";
    const devicePositions = positionsByDevice.get(deviceId) ?? [];
    const result = analyzeMotion(devicePositions, refLat, refLon, profile);
    results.set(deviceId, result);
  }

  return results;
}
