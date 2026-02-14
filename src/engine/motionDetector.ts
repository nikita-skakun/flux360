/**
 * Motion detection and anchoring logic for GPS tracking.
 * This module handles position anchoring using Kalman filtering to create stable position estimates,
 * motion profile configurations for different device types (person vs car), and outlier detection
 * with coherence analysis to handle noisy GPS data.
 */

import type { DevicePoint, Vec2, MotionProfileName } from "@/types";

/**
 * Configuration for motion detection behavior.
 * Different profiles tune the algorithm for expected movement patterns of different device types.
 */
export type MotionProfileConfig = {
  motionScoreThreshold: number; // Threshold for detecting significant motion
  singlePointScoreThreshold: number; // Threshold for considering a single point as motion
  singlePointOverrideMultiplier: number; // Multiplier for single point motion detection
  singlePointAccuracyRatio: number; // Accuracy ratio for single point handling
  minDistanceAccuracyRatio: number; // Minimum distance to accuracy ratio
  coherenceCosineThreshold: number; // Cosine threshold for directional coherence
  coherenceBonus: number; // Bonus for coherent outliers
  accuracyK: number; // Accuracy scaling factor
  weakUpdateGain: number; // Gain for weak updates
  weakVarianceInflation: number; // Variance inflation for weak updates
  anchorVarianceInflationOnNoise: number; // Variance inflation on noise detection
  motionSettleWindowSize: number; // Sliding window size for settling
  motionSettleMahalanobisThreshold: number; // Mahalanobis threshold for point consistency
  motionSettleDirectionThreshold: number; // Max dot product for direction randomness
  maxCentroidRadiusMeters: number; // Max radius for centroid centering in settling
  trendVarianceInflation: number; // Scale factor for variance inflation when reports fall outside anchor circle
  stationaryMahalanobisThreshold: number; // Mahalanobis² threshold: below = stationary update, above = resisted/motion
};

/**
 * Predefined motion profiles for different device types.
 * Person profile: Lower thresholds, faster updates for pedestrian movement.
 * Car profile: Higher thresholds, slower updates for vehicle movement.
 */
export const MOTION_PROFILES: Record<MotionProfileName, MotionProfileConfig> = {
  person: {
    motionScoreThreshold: 0.1,
    singlePointScoreThreshold: 3.0,
    singlePointOverrideMultiplier: 1.8,
    singlePointAccuracyRatio: 2.5,
    minDistanceAccuracyRatio: 0.5,
    coherenceCosineThreshold: 0.7,
    coherenceBonus: 0.2,
    accuracyK: 5,
    weakUpdateGain: 0.25,
    weakVarianceInflation: 4,
    anchorVarianceInflationOnNoise: 1.15,
    motionSettleWindowSize: 3,
    motionSettleMahalanobisThreshold: 100,
    motionSettleDirectionThreshold: 0.5,
    maxCentroidRadiusMeters: 10,
    trendVarianceInflation: 20.0,
    stationaryMahalanobisThreshold: 0.2,
  },
  car: {
    motionScoreThreshold: 4.0,
    singlePointScoreThreshold: 10.0,
    singlePointOverrideMultiplier: 1.8,
    singlePointAccuracyRatio: 3,
    minDistanceAccuracyRatio: 1.5,
    coherenceCosineThreshold: 0.8,
    coherenceBonus: 0.3,
    accuracyK: 8,
    weakUpdateGain: 0.2,
    weakVarianceInflation: 6,
    anchorVarianceInflationOnNoise: 1.35,
    motionSettleWindowSize: 3,
    motionSettleMahalanobisThreshold: 120,
    motionSettleDirectionThreshold: 0.2,
    maxCentroidRadiusMeters: 15,
    trendVarianceInflation: 20.0,
    stationaryMahalanobisThreshold: 25.0,
  },
};

/**
 * Represents an outlier measurement with scoring and direction information.
 */
export type OutlierSample = {
  point: DevicePoint;
  score: number;
  direction: Vec2 | null;
};

/**
 * Check if a set of outlier samples are directionally coherent.
 * Outliers are considered coherent if their directions are sufficiently aligned
 * (above the threshold cosine similarity).
 */
export function computeCoherence(outliers: OutlierSample[], threshold: number): boolean {
  if (outliers.length === 0) return false;
  if (outliers.length === 1) return true;
  let sx = 0;
  let sy = 0;
  for (const o of outliers) {
    if (!o.direction) continue;
    sx += o.direction[0];
    sy += o.direction[1];
  }
  const mag = Math.hypot(sx, sy);
  if (mag === 0) return false;
  const avg: Vec2 = [sx / mag, sy / mag];
  for (const o of outliers) {
    if (!o.direction) return false;
    // Inline dot product: a[0] * b[0] + a[1] * b[1]
    if (o.direction[0] * avg[0] + o.direction[1] * avg[1] < threshold) return false;
  }
  return true;
}
