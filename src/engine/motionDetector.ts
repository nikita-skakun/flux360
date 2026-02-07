/**
 * Motion detection and anchoring logic for GPS tracking.
 * This module handles position anchoring using Kalman filtering to create stable position estimates,
 * motion profile configurations for different device types (person vs car), and outlier detection
 * with coherence analysis to handle noisy GPS data.
 */

import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";

export type MotionProfileName = "person" | "car";

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
  settleWindowSize: number; // Window size for motion settling
  settleMaxSpreadMeters: number; // Max spread in meters for settling
  weakUpdateGain: number; // Gain for weak updates
  weakCovInflation: number; // Covariance inflation for weak updates
  anchorCovInflationOnNoise: number; // Covariance inflation on noise detection
};

/**
 * Predefined motion profiles for different device types.
 * Person profile: Lower thresholds, faster updates for pedestrian movement.
 * Car profile: Higher thresholds, slower updates for vehicle movement.
 */
export const MOTION_PROFILES: Record<MotionProfileName, MotionProfileConfig> = {
  person: {
    motionScoreThreshold: 2.5,
    singlePointScoreThreshold: 4.0,
    singlePointOverrideMultiplier: 1.8,
    singlePointAccuracyRatio: 3,
    minDistanceAccuracyRatio: 1.0,
    coherenceCosineThreshold: 0.7,
    coherenceBonus: 0.2,
    accuracyK: 5,
    settleWindowSize: 3,
    settleMaxSpreadMeters: 10,
    weakUpdateGain: 0.25,
    weakCovInflation: 4,
    anchorCovInflationOnNoise: 1.15,
  },
  car: {
    motionScoreThreshold: 6.0,
    singlePointScoreThreshold: 12.0,
    singlePointOverrideMultiplier: 1.8,
    singlePointAccuracyRatio: 3,
    minDistanceAccuracyRatio: 1.5,
    coherenceCosineThreshold: 0.8,
    coherenceBonus: 0.3,
    accuracyK: 8,
    settleWindowSize: 5,
    settleMaxSpreadMeters: 20,
    weakUpdateGain: 0.2,
    weakCovInflation: 6,
    anchorCovInflationOnNoise: 1.35,
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
 * Scale covariance matrix by a factor.
 */
export function scaleCov(cov: Cov2, factor: number): Cov2 {
  return [cov[0] * factor, cov[1] * factor, cov[2] * factor];
}

/**
 * Calculate Euclidean distance in meters between two points.
 */
export function distanceMeters(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/**
 * Calculate unit vector direction from anchor point to a target point.
 */
export function directionFromAnchor(anchor: Vec2, point: Vec2): Vec2 | null {
  const dx = point[0] - anchor[0];
  const dy = point[1] - anchor[1];
  const mag = Math.hypot(dx, dy);
  if (mag === 0) return null;
  return [dx / mag, dy / mag];
}

/**
 * Compute dot product of two 2D vectors.
 */
export function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

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
    if (dot(o.direction, avg) < threshold) return false;
  }
  return true;
}