import { Anchor } from "./anchor";
import { distance, distanceSquared, directionFromPoints, computeCentroid } from "@/util/geo";
import { MOTION_PROFILES, computeCoherence, type MotionProfileConfig, type OutlierSample } from "./motionDetector";
import { fromWebMercator, WORLD_R } from "@/util/webMercator";
import type { DevicePoint, MotionProfileName, MotionSegment, Timestamp, Vec2 } from "@/types";

// Snapshot for UI/Historical view
export type EngineSnapshot = { activeAnchor: Anchor | null; closedAnchors: Anchor[]; timestamp: Timestamp | null; activeConfidence: number };

// Full engine state for checkpointing
export type EngineState = {
  activeAnchor: Anchor | null;
  closedAnchors: Anchor[];
  lastTimestamp: Timestamp | null;
  motionProfile: MotionProfileName;
  motionActive: boolean;
  motionStartTimestamp: Timestamp | null;
  outliers: OutlierSample[];
  recentMotionPoints: DevicePoint[];
  debugFrames: DebugFrame[];
  seenDebugKeys: Set<string>;
  motionSegments: MotionSegment[];
  currentMotionSegment: MotionSegment | null;
};

const DECAY_RATE_ACTIVE = 0.001;
const GAIN_RATE = 2.0;

export type DebugDecision = 'initialized' | 'updated' | 'resisted' | 'none' | 'noise-weak-update' | 'motion-start' | 'motion-end';
export type DebugFrame = {
  timestamp: Timestamp;
  sourceDeviceId: number | undefined;
  motionActive: boolean;
  motionStartTimestamp: Timestamp | null;
  outlierCount: number;
  motionScore: number | null;
  motionScoreSum: number | null;
  motionCoherent: boolean | null;
  motionDistance: number | null;
  motionTimeFactor: number | null;
  motionSinglePointOverride: boolean | null;
  anchorVarianceScale: number | null;
  measurement: { lat: number; lon: number; accuracy: number; mean: Vec2; variance: number; };
  anchor: { mean: Vec2; variance: number; confidence: number; startTimestamp: Timestamp; lastUpdateTimestamp: Timestamp } | null;
  mahalanobis2: number | null;
  decision: DebugDecision;
  trendSeparation: number | null;
};

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
  lastTimestamp: Timestamp | null = null;
  motionProfile: MotionProfileName = "person";
  motionActive: boolean = false;
  motionStartTimestamp: Timestamp | null = null;
  private outliers: OutlierSample[] = [];
  private recentMotionPoints: DevicePoint[] = [];
  // debug buffer (per-engine)
  private debugFrames: DebugFrame[] = [];
  private seenDebugKeys = new Set<string>();
  motionSegments: MotionSegment[] = [];
  private currentMotionSegment: MotionSegment | null = null;

  getDebugFrames(): DebugFrame[] { return [...this.debugFrames]; }

  clearDebugFrames(): void {
    this.debugFrames = [];
    this.seenDebugKeys.clear();
  }

  setMotionProfile(profile: MotionProfileName) {
    this.motionProfile = profile;
  }

  private normalizeProfileName(profile: MotionProfileName | null): MotionProfileName {
    return profile === "car" ? "car" : "person";
  }

  private getProfile(profile: MotionProfileName | null): MotionProfileConfig {
    return MOTION_PROFILES[this.normalizeProfileName(profile)];
  }

  private insertOutlier(sample: OutlierSample) {
    // Binary search for sorted insertion by timestamp
    let low = 0;
    let high = this.outliers.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.outliers[mid]!.point.timestamp < sample.point.timestamp) low = mid + 1;
      else high = mid;
    }
    this.outliers.splice(low, 0, sample);
  }

  private computeAverageVariance(points: DevicePoint[]): number {
    let sum = 0;
    for (const p of points) sum += p.variance;
    return sum / points.length;
  }

  private computePathLength(path: Vec2[]): number {
    if (path.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      // Convert Web Mercator coordinates to lat/lon and use haversine for accurate distance
      const geo1 = fromWebMercator(path[i - 1]!);
      const geo2 = fromWebMercator(path[i]!);
      total += this.haversineDistance(geo1, geo2);
    }
    return total;
  }

  private haversineDistance(v1: Vec2, v2: Vec2): number {
    const dLon = (v2[0] - v1[0]) * Math.PI / 180;
    const dLat = (v2[1] - v1[1]) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(v1[1] * Math.PI / 180) * Math.cos(v2[1] * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return WORLD_R * c;
  }

  private arePointsConsistent(points: DevicePoint[], threshold: number): boolean {
    if (points.length < 2) return true;
    // Check all points against the centroid to reduce to O(N)
    const centroid = computeCentroid(points.map(p => p.mean));
    for (const p of points) {
      const dx = p.mean[0] - centroid[0];
      const dy = p.mean[1] - centroid[1];
      // Variance of centroid is approximately average variance / N
      // But for consistency check, comparing to centroid with single point variance is a good proxy
      const mahal = (dx * dx + dy * dy) / p.variance;
      if (mahal >= threshold) return false;
    }
    return true;
  }

  private areDirectionsRandom(points: DevicePoint[], threshold: number): boolean {
    if (points.length < 3) return true;
    const directions: Vec2[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i]!;
      const p2 = points[i + 1]!;
      const dx = p2.mean[0] - p1.mean[0];
      const dy = p2.mean[1] - p1.mean[1];
      const mag = Math.hypot(dx, dy);
      if (mag > 1e-6) {
        directions.push([dx / mag, dy / mag]);
      }
    }
    if (directions.length < 2) return true;

    // Check consecutive directions for correlation O(N)
    for (let i = 0; i < directions.length - 1; i++) {
      const d1 = directions[i]!;
      const d2 = directions[i + 1]!;
      const dot = d1[0] * d2[0] + d1[1] * d2[1];
      if (dot >= threshold) return false;
    }
    return true;
  }

  private isCentroidCentered(points: DevicePoint[], maxRadius: number): boolean {
    const centroid = computeCentroid(points.map(p => p.mean));
    const radiusSquared = maxRadius * maxRadius;
    for (const p of points) {
      if (distanceSquared(centroid, p.mean) > radiusSquared) return false;
    }
    return true;
  }

  private shouldSettle(profile: MotionProfileConfig): boolean {
    if (this.recentMotionPoints.length < profile.motionSettleWindowSize) return false;
    const points = this.recentMotionPoints.slice(-profile.motionSettleWindowSize);
    const consistent = this.arePointsConsistent(points, profile.motionSettleMahalanobisThreshold);
    const randomDir = this.areDirectionsRandom(points, profile.motionSettleDirectionThreshold);
    const centered = this.isCentroidCentered(points, profile.maxCentroidRadiusMeters);
    return consistent && randomDir && centered;
  }

  private pushDebugFrame(frame: DebugFrame) {
    const key = `${frame.timestamp}:${frame.measurement.lat}:${frame.measurement.lon}:${frame.measurement.accuracy}:${frame.sourceDeviceId ?? ''}`;
    if (this.seenDebugKeys.has(key)) return;
    this.seenDebugKeys.add(key);
    this.debugFrames.push(frame);
  }

  processMeasurements(ms: DevicePoint[]): EngineSnapshot[] {
    const snapshots: EngineSnapshot[] = [];
    for (const m of ms) {
      // No reference coordinates needed with Web Mercator
      const profile = this.getProfile(this.motionProfile);
      let motionScore: number | null = null;
      let motionScoreSum: number | null = null;
      let motionCoherent: boolean | null = null;
      let motionDistance: number | null = null;
      let motionTimeFactor: number | null = null;
      let motionSinglePointOverride: boolean | null = null;
      let anchorVarianceScale: number | null = null;
      let mahalanobis2: number | null = null;
      let trendSeparation: number | null = null;
      let decision: DebugDecision = 'none';

      if (this.activeAnchor === null) {
        // Initialize with the first measurement
        this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], m.variance, m.timestamp, m.timestamp);

        this.motionActive = false;
        this.motionStartTimestamp = null;
        this.outliers = [];
        this.recentMotionPoints = [];
        decision = 'initialized';
      } else {
        const dist2Active = this.activeAnchor.mahalanobis2(m);
        mahalanobis2 = dist2Active;

        if (!this.motionActive) {
          if (dist2Active < profile.stationaryMahalanobisThreshold) {
            // Detect stationary drift: when reports consistently fall outside the anchor's accuracy circle,
            // we inflate the anchor's variance to allow it to move toward the new position.
            const dist = distance(this.activeAnchor.mean, m.mean);
            const anchorRadius = Math.sqrt(this.activeAnchor.variance);
            const reportRadius = m.accuracy;
            const separation = dist - (anchorRadius + reportRadius);
            trendSeparation = separation;

            if (separation > 0) {
              // Accuracy circles don't overlap: inflate variance proportionally to separation.
              // Division by variance (accuracy²) ensures inaccurate reports have minimal impact.
              const inflation = 1 + (separation / m.variance) * profile.trendVarianceInflation;
              this.activeAnchor.variance *= inflation;
              this.activeAnchor.confidence /= inflation;
            }

            this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
            decision = 'updated';

            this.outliers = [];
          } else {
            decision = 'resisted';
            const lastConfirm = this.activeAnchor.lastUpdateTimestamp ?? m.timestamp;
            const dtMinutes = Math.max(0, (m.timestamp - lastConfirm) / 60000);
            const distToMean = distance(this.activeAnchor.mean, m.mean);
            if (distToMean < m.accuracy * profile.minDistanceAccuracyRatio || distToMean <= Math.sqrt(this.activeAnchor.variance) + m.accuracy) {
              // Center is within the noise-gate radius, OR the GPS circles still overlap —
              // both cases are geometrically consistent with being stationary.
              const weakVariance = m.variance * profile.weakVarianceInflation;
              const weakPoint: DevicePoint = { ...m, variance: weakVariance };
              this.activeAnchor.kalmanUpdate(weakPoint, GAIN_RATE);
              this.activeAnchor.variance *= profile.anchorVarianceInflationOnNoise;
              anchorVarianceScale = profile.anchorVarianceInflationOnNoise;
              decision = 'noise-weak-update';
            } else {
              const timeFactor = Math.log1p(dtMinutes + 1);
              const score = (distToMean / (m.accuracy + profile.accuracyK)) * timeFactor;
              const direction = directionFromPoints(this.activeAnchor.mean, m.mean);
              this.insertOutlier({ point: m, score, direction });

              const coherence = computeCoherence(this.outliers, profile.coherenceCosineThreshold);
              const sumScore = this.outliers.reduce((acc, o) => acc + o.score, 0);
              const adjustedScore = coherence ? sumScore * (1 + profile.coherenceBonus) : sumScore;

              motionScore = score;
              motionScoreSum = adjustedScore;
              motionCoherent = coherence;
              motionDistance = distToMean;
              motionTimeFactor = timeFactor;
              const overrideByScore = score >= profile.singlePointScoreThreshold * profile.singlePointOverrideMultiplier;
              const overrideByAccuracy = distToMean >= m.accuracy * profile.singlePointAccuracyRatio;
              motionSinglePointOverride = overrideByScore && overrideByAccuracy;

              const singlePointTriggers = (score >= profile.singlePointScoreThreshold) && motionSinglePointOverride;
              const bufferTriggers = adjustedScore >= profile.motionScoreThreshold && (this.outliers.length >= 2 || motionSinglePointOverride);

              if (singlePointTriggers || bufferTriggers) {
                this.motionActive = true;
                this.motionStartTimestamp = (this.outliers[0]?.point.timestamp ?? m.timestamp);
                this.recentMotionPoints = [];
                this.recentMotionPoints.push(m);
                this.outliers = [];
                decision = 'motion-start';
                // Start a new motion segment - clone the anchor to preserve its state
                this.currentMotionSegment = {
                  startAnchor: this.activeAnchor.clone(),
                  endAnchor: null,
                  path: [this.activeAnchor.mean],
                  startTime: this.motionStartTimestamp ?? m.timestamp,
                  endTime: null,
                  distance: 0,
                  duration: 0,
                };
              }
            }
          }
        } else {
          if (dist2Active < profile.stationaryMahalanobisThreshold) {
            this.motionActive = false;
            this.motionStartTimestamp = null;
            this.outliers = [];
            this.activeAnchor.kalmanUpdate(m, GAIN_RATE);

            decision = 'motion-end';
            // Finalize motion segment
            if (this.currentMotionSegment) {
              // Clone the anchor to preserve its state at motion end
              this.currentMotionSegment.endAnchor = this.activeAnchor.clone();
              this.currentMotionSegment.path.push(this.activeAnchor.mean);
              this.currentMotionSegment.endTime = m.timestamp;
              this.currentMotionSegment.duration = this.currentMotionSegment.endTime - this.currentMotionSegment.startTime;
              this.currentMotionSegment.distance = this.computePathLength(this.currentMotionSegment.path);

              // Use distanceSquared for fast 1m pruning (1m^2 = 1)
              const start = this.currentMotionSegment.path[0];
              const end = this.activeAnchor.mean;
              const directDistSq = start && end ? distanceSquared(start, end) : 0;

              if (this.currentMotionSegment.distance > 1.0 || directDistSq > 1.0) {
                this.motionSegments.push(this.currentMotionSegment);
              }
              this.currentMotionSegment = null;
            }
          } else {
            this.recentMotionPoints.push(m);
            // Add motion point to current segment
            if (this.currentMotionSegment) {
              this.currentMotionSegment.path.push(m.mean);
            }
            if (this.recentMotionPoints.length > profile.motionSettleWindowSize) this.recentMotionPoints.shift();
            if (this.recentMotionPoints.length >= profile.motionSettleWindowSize && this.shouldSettle(profile)) {
              const points = this.recentMotionPoints.slice(-profile.motionSettleWindowSize);
              const newMean = computeCentroid(points.map(p => p.mean));
              const newVariance = this.computeAverageVariance(points);
              this.activeAnchor.endTimestamp = m.timestamp;
              this.closedAnchors.push(this.activeAnchor);
              const newAnchor = new Anchor(newMean, newVariance, m.timestamp, m.timestamp);
              this.activeAnchor = newAnchor;
              this.motionActive = false;
              this.motionStartTimestamp = null;
              this.outliers = [];
              this.recentMotionPoints = [];
              decision = 'motion-end';
              // Finalize motion segment
              if (this.currentMotionSegment) {
                // newAnchor is freshly created, no need to clone
                this.currentMotionSegment.endAnchor = newAnchor;
                this.currentMotionSegment.path.push(newAnchor.mean);
                this.currentMotionSegment.endTime = m.timestamp;
                this.currentMotionSegment.duration = this.currentMotionSegment.endTime - this.currentMotionSegment.startTime;
                this.currentMotionSegment.distance = this.computePathLength(this.currentMotionSegment.path);

                const start = this.currentMotionSegment.path[0];
                const end = newAnchor.mean;
                const directDistSq = start && end ? distanceSquared(start, end) : 0;

                if (this.currentMotionSegment.distance > 1.0 || directDistSq > 1.0) {
                  this.motionSegments.push(this.currentMotionSegment);
                }
                this.currentMotionSegment = null;
              }
            }
          }
        }
      }

      // capture state after
      const afterAnchor = this.activeAnchor ? this.activeAnchor.clone() : null;

      // push debug frame (non-intrusive)
      this.pushDebugFrame({
        timestamp: m.timestamp,
        sourceDeviceId: m.sourceDeviceId,
        motionActive: this.motionActive,
        motionStartTimestamp: this.motionStartTimestamp,
        outlierCount: this.outliers.length,
        motionScore,
        motionScoreSum,
        motionCoherent,
        motionDistance,
        motionTimeFactor,
        motionSinglePointOverride,
        anchorVarianceScale,
        measurement: { lat: m.lat, lon: m.lon, accuracy: m.accuracy, mean: [m.mean[0], m.mean[1]], variance: m.variance },
        anchor: afterAnchor ? { mean: [afterAnchor.mean[0], afterAnchor.mean[1]], variance: afterAnchor.variance, confidence: afterAnchor.confidence, startTimestamp: afterAnchor.startTimestamp, lastUpdateTimestamp: afterAnchor.lastUpdateTimestamp } : null,
        mahalanobis2,
        decision,
        trendSeparation,
      });

      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp, DECAY_RATE_ACTIVE) : 0 });
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot {
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp as Timestamp, DECAY_RATE_ACTIVE) : 0 };
  }

  getDominantAnchorAt(timestamp: Timestamp): Anchor | null {
    const candidates: Anchor[] = [];
    if (this.activeAnchor && this.activeAnchor.startTimestamp <= timestamp) {
      candidates.push(this.activeAnchor);
    }
    for (const anchor of this.closedAnchors) {
      if (anchor.startTimestamp <= timestamp && (anchor.endTimestamp === null || timestamp <= anchor.endTimestamp)) {
        candidates.push(anchor);
      }
    }
    if (candidates.length === 0) return null;
    let best: Anchor | null = null;
    let bestConf = -1;
    for (const anchor of candidates) {
      const conf = anchor.getConfidence(timestamp, DECAY_RATE_ACTIVE);
      if (conf > bestConf) {
        bestConf = conf;
        best = anchor;
      }
    }
    return best;
  }

  createSnapshot(): EngineState {
    return {
      activeAnchor: this.activeAnchor ? this.activeAnchor.clone() : null,
      closedAnchors: this.closedAnchors.map(a => a.clone()),
      lastTimestamp: this.lastTimestamp,
      motionProfile: this.motionProfile,
      motionActive: this.motionActive,
      motionStartTimestamp: this.motionStartTimestamp,
      outliers: structuredClone(this.outliers), // Use structuredClone for deep copy
      recentMotionPoints: structuredClone(this.recentMotionPoints),
      debugFrames: [...this.debugFrames],
      seenDebugKeys: new Set(this.seenDebugKeys),
      motionSegments: this.motionSegments.map(s => ({
        startAnchor: s.startAnchor.clone(),
        endAnchor: s.endAnchor ? s.endAnchor.clone() : null,
        path: structuredClone(s.path),
        startTime: s.startTime,
        endTime: s.endTime,
        distance: s.distance,
        duration: s.duration,
      })),
      currentMotionSegment: this.currentMotionSegment ? {
        startAnchor: this.currentMotionSegment.startAnchor.clone(),
        endAnchor: this.currentMotionSegment.endAnchor ? this.currentMotionSegment.endAnchor.clone() : null,
        path: structuredClone(this.currentMotionSegment.path),
        startTime: this.currentMotionSegment.startTime,
        endTime: this.currentMotionSegment.endTime,
        distance: this.currentMotionSegment.distance,
        duration: this.currentMotionSegment.duration,
      } : null,
    };
  }

  pruneHistory(olderThan: Timestamp) {
    // Remove completed segments that ended before the cutoff time
    this.motionSegments = this.motionSegments.filter(s => {
      // Keep active segments
      if (!s.endAnchor) return true;
      // Keep segments that ended within the valid window
      // We use lastUpdateTimestamp as the effective "end time" of the anchor
      return s.endAnchor.lastUpdateTimestamp >= olderThan;
    });
  }

  restoreSnapshot(state: EngineState): void {
    this.activeAnchor = state.activeAnchor ? state.activeAnchor.clone() : null;
    this.closedAnchors = state.closedAnchors.map(a => a.clone());
    this.lastTimestamp = state.lastTimestamp;
    this.motionProfile = state.motionProfile;
    this.motionActive = state.motionActive;
    this.motionStartTimestamp = state.motionStartTimestamp;
    this.outliers = structuredClone(state.outliers);
    this.recentMotionPoints = structuredClone(state.recentMotionPoints);
    this.debugFrames = [...state.debugFrames];
    this.seenDebugKeys = new Set(state.seenDebugKeys);
    this.motionSegments = state.motionSegments.map(s => ({
      startAnchor: s.startAnchor.clone(),
      endAnchor: s.endAnchor ? s.endAnchor.clone() : null,
      path: structuredClone(s.path),
      startTime: s.startTime,
      endTime: s.endTime,
      distance: s.distance,
      duration: s.duration,
    }));
    this.currentMotionSegment = state.currentMotionSegment ? {
      startAnchor: state.currentMotionSegment.startAnchor.clone(),
      endAnchor: state.currentMotionSegment.endAnchor ? state.currentMotionSegment.endAnchor.clone() : null,
      path: structuredClone(state.currentMotionSegment.path),
      startTime: state.currentMotionSegment.startTime,
      endTime: state.currentMotionSegment.endTime,
      distance: state.currentMotionSegment.distance,
      duration: state.currentMotionSegment.duration,
    } : null;
  }
}
