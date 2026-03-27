/**
 * Motion detection and anchoring logic for GPS tracking.
 */

import type { MotionProfileName } from "@/types";

// Engine constants
export const ENGINE_WINDOW_SIZE = 50; // sliding window for recent points
export const PENDING_THRESHOLD = 5; // minimum pending points to trigger motion check
export const MIN_PATH_POINTS = 5; // minimum points in path for significance checks
export const HARD_BREAKOUT_DISTANCE = 100; // meters from original anchor to force motion
export const SETTLING_WINDOW_CAP = 20; // max points in motion settling window
export const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_CHECKPOINTS = 50; // maximum number of checkpoints per engine

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
    maxMergeGapDuration: 15 * 60 * 1000,
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
    maxMergeGapDuration: 15 * 60 * 1000,
  },
};
