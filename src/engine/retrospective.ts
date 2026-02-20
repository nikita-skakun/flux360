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

// Distance between two points in meters
function distanceMeters(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Convert position to meters-based point
function toMeterPoint(
  p: NormalizedPosition,
  refLat: number,
  refLon: number
): { mean: Vec2; variance: number; timestamp: number; accuracy: number } {
  const { x, y } = degreesToMeters(p.lat, p.lon, refLat, refLon);
  const variance = p.accuracy * p.accuracy;
  return { mean: [x, y], variance, timestamp: p.timestamp, accuracy: p.accuracy };
}

/**
 * Analyze motion retrospectively to detect TRUE motion boundaries.
 * 
 * Strategy:
 * 1. Identify "Stable Intervals" (stops) where the device stays within a small radius 
 *    for a minimum duration.
 * 2. Everything between these Stable Intervals is considered a "Motion Segment".
 * 3. This prevents fragmentation caused by brief stops (traffic lights, waiting) 
 *    which often break motion segments in real-time analysis.
 */
export function analyzeMotion(
  positions: NormalizedPosition[],
  refLat: number,
  refLon: number,
  motionProfile: MotionProfileName = "person"
): RetrospectiveResult {
  if (positions.length === 0) {
    return { motionSegments: [] };
  }

  // Sort by timestamp
  const sorted = [...positions].sort((a, b) => a.timestamp - b.timestamp);
  const profile = MOTION_PROFILES[motionProfile];
  
  // Tuning parameters from profile
  const minStationaryDuration = profile.retrospectiveMinStationaryDuration;
  const maxStationaryRadius = profile.retrospectiveMaxStationaryRadius;
  
  const meterPoints = sorted.map((p, idx) => ({ ...toMeterPoint(p, refLat, refLon), index: idx }));
  const len = meterPoints.length;
  
  // Step 1: Identify Stable Intervals
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
    // Start a potential cluster
    const startPoint = meterPoints[i]!;
    let j = i + 1;
    let centroidX = startPoint.mean[0];
    let centroidY = startPoint.mean[1];
    let count = 1;
    
    // Expand cluster as long as it fits in radius
    while (j < len) {
      const nextPoint = meterPoints[j]!;
      
      // Check distance to current running centroid
      const dist = distanceMeters([centroidX / count, centroidY / count], nextPoint.mean);
      
      if (dist > maxStationaryRadius) {
        break; // Cluster broken
      }
      
      // Update centroid
      centroidX += nextPoint.mean[0];
      centroidY += nextPoint.mean[1];
      count++;
      j++;
    }
    
    // Check if this cluster qualifies as a Stable Interval
    const startTime = startPoint.timestamp;
    const endTime = meterPoints[j - 1]!.timestamp;
    const duration = endTime - startTime;
    
    // Qualifies if it lasts long enough OR if it's the very first/last point (anchors)
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
      i = j; // Advance past this cluster
    } else {
      i++; // This point is part of motion, try starting cluster from next point
    }
  }
  
  // Merge adjacent stable intervals if they are close (optimization)
  // This handles cases where a cluster drifted slightly but is effectively the same stop
  const mergedIntervals: StableInterval[] = [];
  if (stableIntervals.length > 0) {
    let current = stableIntervals[0]!;
    for (let k = 1; k < stableIntervals.length; k++) {
      const next = stableIntervals[k]!;
      const dist = distanceMeters(current.center, next.center);
      const timeGap = next.startTime - current.endTime;
      
      // Merge if spatially close AND temporally close
      if (dist < maxStationaryRadius && timeGap < 30000) {
        // Merge
        const newCount = (current.endIndex - current.startIndex + 1) + (next.endIndex - next.startIndex + 1);
        const currentSumX = current.center[0] * (current.endIndex - current.startIndex + 1);
        const currentSumY = current.center[1] * (current.endIndex - current.startIndex + 1);
        const nextSumX = next.center[0] * (next.endIndex - next.startIndex + 1);
        const nextSumY = next.center[1] * (next.endIndex - next.startIndex + 1);
        
        current = {
          startIndex: current.startIndex, // Keep start
          endIndex: next.endIndex,     // Extend end
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
  
  // Step 2: Generate Motion Segments between Stable Intervals
  const motionSegments: RetrospectiveMotionSegment[] = [];
  
  for (let k = 0; k < mergedIntervals.length - 1; k++) {
    const from = mergedIntervals[k]!;
    const to = mergedIntervals[k + 1]!;
    
    // Motion is typically between from.endIndex and to.startIndex
    // But we include the anchor centers as start/end points for visual continuity
    
    const segmentStartIdx = from.endIndex;
    const segmentEndIdx = to.startIndex;
    
    // Only create segment if there is actual time/distance gap
    if (segmentEndIdx > segmentStartIdx) {
      const path: Vec2[] = [from.center]; // Start at anchor center
      
      // Add all points in between
      for (let idx = segmentStartIdx; idx <= segmentEndIdx; idx++) {
         // Optimization: Simplify path? No, keep full fidelity for now.
         // Maybe skip points that are essentially same as previous to save memory
         path.push(meterPoints[idx]!.mean);
      }
      
      path.push(to.center); // End at anchor center
      
      motionSegments.push({
        startTime: from.endTime,
        endTime: to.startTime,
        startPosition: from.center,
        endPosition: to.center,
        path,
        confidence: 1.0
      });
    }
  }
  
  // Handle case: Moving at the very end (Last interval is not the last point)
  if (mergedIntervals.length > 0) {
    const lastInterval = mergedIntervals[mergedIntervals.length - 1]!;
    if (lastInterval.endIndex < len - 1) {
      // We have trailing motion
      const path: Vec2[] = [lastInterval.center];
      for (let idx = lastInterval.endIndex; idx < len; idx++) {
        path.push(meterPoints[idx]!.mean);
      }
      
      motionSegments.push({
        startTime: lastInterval.endTime,
        endTime: meterPoints[len - 1]!.timestamp,
        startPosition: lastInterval.center,
        endPosition: meterPoints[len - 1]!.mean,
        path,
        confidence: 0.8 // Incomplete
      });
    }
  } else if (len > 1) {
    // No stable intervals at all? Whole thing is one motion.
    const path = meterPoints.map(p => p.mean);
    motionSegments.push({
      startTime: meterPoints[0]!.timestamp,
      endTime: meterPoints[len - 1]!.timestamp,
      startPosition: meterPoints[0]!.mean,
      endPosition: meterPoints[len - 1]!.mean,
      path,
      confidence: 0.5
    });
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
  
  // Pre-filter positions by device to avoid repeated filters in analyzeDeviceMotion
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
    const result = analyzeMotion(
      devicePositions,
      refLat,
      refLon,
      profile
    );
    results.set(deviceId, result);
  }

  return results;
}
