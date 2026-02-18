import { degreesToMeters } from "@/util/geo";
import type { NormalizedPosition, Vec2, MotionProfileName } from "@/types";
import { MOTION_PROFILES } from "./motionDetector";

export type RetrospectiveAnchor = {
  timestamp: number;
  mean: Vec2;
  variance: number;
  type: "stable" | "moving" | "settling";
};

export type RetrospectiveMotionSegment = {
  startTime: number;
  endTime: number;
  startPosition: Vec2;
  endPosition: Vec2;
  path: Vec2[];
  confidence: number;
};

export type RetrospectiveResult = {
  anchorTimeline: RetrospectiveAnchor[];
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
 * PROBLEM: Real-time engine detects motion reactively - it needs evidence before 
 * declaring motion. This creates lag. The motion segment shows the settling period 
 * (B→D) instead of the actual transition (A→B).
 * 
 * SOLUTION: Look at position history and identify when device ACTUALLY moved.
 * - Find the last stable point before the jump (point A)
 * - Find the first point at the new location (point B) 
 * - Motion = transition from A to B (not the settling after B)
 * 
 * KEY DIFFERENCE FROM REAL-TIME:
 * - Real-time: Motion starts when outlier buffer triggers (after seeing multiple outliers)
 * - Retrospective: Motion starts from last stable point BEFORE the jump
 * - This captures the actual transition, not just the settling period
 */
export function analyzeMotion(
  positions: NormalizedPosition[],
  refLat: number,
  refLon: number,
  motionProfile: MotionProfileName = "person"
): RetrospectiveResult {
  if (positions.length === 0) {
    return { anchorTimeline: [], motionSegments: [] };
  }

  // Sort by timestamp
  const sorted = [...positions].sort((a, b) => a.timestamp - b.timestamp);
  const profile = MOTION_PROFILES[motionProfile];
  
  // Use MORE AGGRESSIVE thresholds for retrospective detection
  // We can afford false positives because we have full context
  const motionThreshold = profile.stationaryMahalanobisThreshold * 0.5; // Half the threshold = more sensitive
  const minMotionDistance = 10; // Must move at least 10 meters to count as motion
  
  const anchorTimeline: RetrospectiveAnchor[] = [];
  const motionSegments: RetrospectiveMotionSegment[] = [];
  
  // Track stable periods and transitions
  let currentStableCenter: Vec2 | null = null;
  let currentStableVariance = 0;
  let currentStableIndices: number[] = [];
  let lastStablePoint: { timestamp: number; position: Vec2; index: number } | null = null;
  
  // Convert all to meter points first
  const meterPoints = sorted.map((p, idx) => ({ ...toMeterPoint(p, refLat, refLon), index: idx }));
  
  for (let i = 0; i < meterPoints.length; i++) {
    const point = meterPoints[i]!;
    
    if (currentStableCenter === null) {
      // First point - start first stable period
      currentStableCenter = [point.mean[0], point.mean[1]];
      currentStableVariance = point.variance;
      currentStableIndices = [i];
      
      anchorTimeline.push({
        timestamp: point.timestamp,
        mean: [point.mean[0], point.mean[1]],
        variance: point.variance,
        type: "stable",
      });
      continue;
    }
    
    // Check if this point fits with current stable cluster
    const dx = point.mean[0] - currentStableCenter[0];
    const dy = point.mean[1] - currentStableCenter[1];
    const distSq = dx * dx + dy * dy;
    const mahal2 = distSq / Math.max(currentStableVariance + point.variance, 1e-6);
    
    if (mahal2 < motionThreshold) {
      // Point fits with current stable cluster - update centroid
      const n = currentStableIndices.length;
      currentStableCenter[0] = (currentStableCenter[0] * n + point.mean[0]) / (n + 1);
      currentStableCenter[1] = (currentStableCenter[1] * n + point.mean[1]) / (n + 1);
      currentStableVariance = (currentStableVariance * n + point.variance) / (n + 1);
      currentStableIndices.push(i);
      
      // Update last stable point (use the last point in the cluster as the "exit" point)
      lastStablePoint = {
        timestamp: point.timestamp,
        position: [point.mean[0], point.mean[1]],
        index: i,
      };
      
      anchorTimeline.push({
        timestamp: point.timestamp,
        mean: [currentStableCenter[0], currentStableCenter[1]],
        variance: currentStableVariance,
        type: "stable",
      });
    } else {
      // Point is outside current stable cluster - we're in motion or at a new location
      
      // Check if we've accumulated enough "outlier" points to confirm this is a new location
      // Look ahead to see if future points cluster here
      const lookAheadWindow = 3;
      const futurePoints = meterPoints.slice(i, Math.min(i + lookAheadWindow, meterPoints.length));
      
      // Calculate centroid of future points
      if (futurePoints.length >= 2) {
        let futureCentroidX = 0;
        let futureCentroidY = 0;
        for (const fp of futurePoints) {
          futureCentroidX += fp.mean[0];
          futureCentroidY += fp.mean[1];
        }
        futureCentroidX /= futurePoints.length;
        futureCentroidY /= futurePoints.length;
        
        const distFromOld = distanceMeters(currentStableCenter, [futureCentroidX, futureCentroidY]);
        
        // If future points are far from old location and cluster together, this is a real move
        let futureVariance = 0;
        for (const fp of futurePoints) {
          const fdx = fp.mean[0] - futureCentroidX;
          const fdy = fp.mean[1] - futureCentroidY;
          futureVariance += fdx * fdx + fdy * fdy;
        }
        futureVariance /= futurePoints.length;
        
        const isNewLocation = distFromOld > minMotionDistance && futureVariance < 1000; // Clustered
        
        if (isNewLocation && lastStablePoint) {
          // This is a real transition!
          // Motion starts from lastStablePoint (last point at old location)
          // NOT from when we first detected the outlier
          
          // Build path from last stable point through transition to new stable point
          const path: Vec2[] = [lastStablePoint.position];
          for (let j = lastStablePoint.index + 1; j <= i; j++) {
            const p = meterPoints[j];
            if (p) {
              path.push([p.mean[0], p.mean[1]]);
            }
          }
          
          motionSegments.push({
            startTime: lastStablePoint.timestamp,
            endTime: point.timestamp,
            startPosition: lastStablePoint.position,
            endPosition: [point.mean[0], point.mean[1]],
            path,
            confidence: 0.9, // High confidence for retrospective
          });
          
          // Start new stable period at new location
          currentStableCenter = [futureCentroidX, futureCentroidY];
          currentStableVariance = futureVariance;
          currentStableIndices = [i];
          lastStablePoint = {
            timestamp: point.timestamp,
            position: [point.mean[0], point.mean[1]],
            index: i,
          };
          
          anchorTimeline.push({
            timestamp: point.timestamp,
            mean: [futureCentroidX, futureCentroidY],
            variance: futureVariance,
            type: "stable",
          });
          
          // Skip ahead past the points we already processed
          i += futurePoints.length - 1;
        } else {
          // Not a clear transition - mark as moving
          anchorTimeline.push({
            timestamp: point.timestamp,
            mean: [point.mean[0], point.mean[1]],
            variance: point.variance,
            type: "moving",
          });
        }
      } else {
        // Not enough future points to determine - mark as moving
        anchorTimeline.push({
          timestamp: point.timestamp,
          mean: [point.mean[0], point.mean[1]],
          variance: point.variance,
          type: "moving",
        });
      }
    }
  }
  
  return { anchorTimeline, motionSegments };
}

/**
 * Run retrospective analysis for a single device.
 * Wrapper around analyzeMotion with device filtering.
 */
export function analyzeDeviceMotion(
  deviceId: number,
  allPositions: NormalizedPosition[],
  refLat: number,
  refLon: number,
  motionProfile: MotionProfileName = "person"
): RetrospectiveResult {
  const devicePositions = allPositions.filter((p) => p.device === deviceId);
  return analyzeMotion(devicePositions, refLat, refLon, motionProfile);
}

/**
 * Run retrospective analysis for all devices.
 * Returns a map of deviceId to retrospective results.
 */
export function analyzeAllDevices(
  positions: NormalizedPosition[],
  deviceIds: number[],
  refLat: number,
  refLon: number,
  motionProfiles: Record<number, MotionProfileName>
): Map<number, RetrospectiveResult> {
  const results = new Map<number, RetrospectiveResult>();

  for (const deviceId of deviceIds) {
    const profile = motionProfiles[deviceId] ?? "person";
    const result = analyzeDeviceMotion(
      deviceId,
      positions,
      refLat,
      refLon,
      profile
    );
    results.set(deviceId, result);
  }

  return results;
}
