/**
 * Motion detection and anchoring logic for GPS tracking.
 */

import type { MotionProfileName } from "@/types";

/**
 * Configuration for motion detection behavior.
 */
export type MotionProfileConfig = {
  stationaryMahalanobisThreshold: number; // Mahalanobis² threshold: below = stationary update
  coherenceCosineThreshold: number; // Cosine threshold for directional coherence (Alignment Gate)
  motionSettleWindowSize: number; // Min points to consider for settlement
  motionSettleMahalanobisThreshold: number; // Mahalanobis threshold for group stability
  minStationaryDuration: number; // Duration in ms to consider a stop "stable"
  maxStationaryRadius: number; // Radius in meters to cluster stable points
  minAverageVelocity: number; // Minimum average net velocity (m/s) to be significant
  minEfficiency: number; // Minimum net displacement / total distance ratio
  maxMergeGapDuration: number; // Max stationary gap (ms) to merge adjacent motions
};

/**
 * Predefined motion profiles.
 */
export const MOTION_PROFILES: Record<MotionProfileName, MotionProfileConfig> = {
  person: {
    stationaryMahalanobisThreshold: 2.0,
    coherenceCosineThreshold: 0.7,
    motionSettleWindowSize: 2,
    motionSettleMahalanobisThreshold: 100,
    minStationaryDuration: 60 * 1000,
    maxStationaryRadius: 20,
    minAverageVelocity: 0.8,
    minEfficiency: 0.5,
    maxMergeGapDuration: 5 * 60 * 1000,
  },
  car: {
    stationaryMahalanobisThreshold: 25.0,
    coherenceCosineThreshold: 0.8,
    motionSettleWindowSize: 2,
    motionSettleMahalanobisThreshold: 120,
    minStationaryDuration: 45 * 1000,
    maxStationaryRadius: 25,
    minAverageVelocity: 2.5,
    minEfficiency: 0.6,
    maxMergeGapDuration: 5 * 60 * 1000,
  },
};
