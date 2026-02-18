import { Anchor } from "./anchor";
import { distanceMeters, directionFromPoints, computeCentroid, metersToDegrees } from "@/util/geo";
import { MOTION_PROFILES, computeCoherence, type MotionProfileConfig, type OutlierSample } from "./motionDetector";
import type { DevicePoint, MotionProfileName, MotionSegment, Vec2 } from "@/types";

// Snapshot for UI/Historical view
export type EngineSnapshot = { activeAnchor: Anchor | null; closedAnchors: Anchor[]; timestamp: number | null; activeConfidence: number };

// Full engine state for checkpointing
export type EngineState = {
  activeAnchor: Anchor | null;
  closedAnchors: Anchor[];
  lastTimestamp: number | null;
  motionProfile: MotionProfileName;
  motionActive: boolean;
  motionStartTimestamp: number | null;
  outliers: OutlierSample[];
  recentMotionPoints: DevicePoint[];
  debugFrames: DebugFrame[];
  seenDebugKeys: Set<string>;
  motionSegments: MotionSegment[];
  currentMotionSegment: MotionSegment | null;
  refLat: number | null;
  refLon: number | null;
};

const DECAY_RATE_ACTIVE = 0.001;
const GAIN_RATE = 2.0;

export type DebugDecision = 'initialized' | 'updated' | 'resisted' | 'none' | 'noise-weak-update' | 'motion-start' | 'motion-end';
export type DebugFrame = {
  timestamp: number;
  sourceDeviceId: number | undefined;
  motionActive: boolean;
  motionStartTimestamp: number | null;
  outlierCount: number;
  motionScore: number | null;
  motionScoreSum: number | null;
  motionCoherent: boolean | null;
  motionDistance: number | null;
  motionTimeFactor: number | null;
  motionSinglePointOverride: boolean | null;
  anchorVarianceScale: number | null;
  measurement: { lat: number; lon: number; accuracy: number; mean: [number, number]; variance: number; };
  anchor: { mean: [number, number]; variance: number; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  mahalanobis2: number | null;
  decision: DebugDecision;
  trendSeparation: number | null;
};

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
  lastTimestamp: number | null = null;
  motionProfile: MotionProfileName = "person";
  motionActive: boolean = false;
  motionStartTimestamp: number | null = null;
  private outliers: OutlierSample[] = [];
  private recentMotionPoints: DevicePoint[] = [];
  // debug buffer (per-engine)
  private debugFrames: DebugFrame[] = [];
  private seenDebugKeys = new Set<string>();
  motionSegments: MotionSegment[] = [];
  private currentMotionSegment: MotionSegment | null = null;
  // Reference coordinates for distance calculations
  private refLat: number | null = null;
  private refLon: number | null = null;
  getDebugFrames(): DebugFrame[] { return [...this.debugFrames]; }
  clearDebugFrames(): void {
    this.debugFrames = [];
    this.seenDebugKeys.clear();
  }
  setMotionProfile(profile: MotionProfileName) {
    this.motionProfile = profile;
  }
  private normalizeProfileName(profile?: MotionProfileName | null): MotionProfileName {
    return profile === "car" ? "car" : "person";
  }
  private getProfile(profile?: MotionProfileName | null): MotionProfileConfig {
    return MOTION_PROFILES[this.normalizeProfileName(profile)];
  }
  private insertOutlier(sample: OutlierSample) {
    this.outliers.push(sample);
    this.outliers.sort((a, b) => a.point.timestamp - b.point.timestamp);
  }
  private computeAverageVariance(points: DevicePoint[]): number {
    let sum = 0;
    for (const p of points) sum += p.variance;
    return sum / points.length;
  }
  private computePathLength(path: Vec2[]): number {
    if (path.length < 2) return 0;
    if (this.refLat === null || this.refLon === null) {
      // Fall back to Euclidean if no reference available
      let total = 0;
      for (let i = 1; i < path.length; i++) {
        total += distanceMeters(path[i - 1]!, path[i]!);
      }
      return total;
    }
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const p1 = path[i - 1]!;
      const p2 = path[i]!;
      // Convert back to lat/lon and use haversine for accurate distance
      const geo1 = metersToDegrees(p1[0], p1[1], this.refLat, this.refLon);
      const geo2 = metersToDegrees(p2[0], p2[1], this.refLat, this.refLon);
      total += this.haversineDistance(geo1.lat, geo1.lon, geo2.lat, geo2.lon);
    }
    return total;
  }
  
  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  private arePointsConsistent(points: DevicePoint[], threshold: number): boolean {
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const p1 = points[i];
        const p2 = points[j];
        if (!p1 || !p2) return false;
        const dx = p1.mean[0] - p2.mean[0];
        const dy = p1.mean[1] - p2.mean[1];
        const mahal = (dx * dx + dy * dy) / (p1.variance + p2.variance);
        if (mahal >= threshold) return false;
      }
    }
    return true;
  }
  private areDirectionsRandom(points: DevicePoint[], threshold: number): boolean {
    // Evaluates if directions between consecutive points are random (low correlation via dot product).
    // Random directions suggest stationary/noisy movement rather than coherent travel, qualifying for settling.
    // Threshold ensures pairs aren't too aligned (e.g., dot < threshold means uncorrelated).
    if (points.length < 2) return false;
    const directions: [number, number][] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (!p1 || !p2) return false;
      const dx = p2.mean[0] - p1.mean[0];
      const dy = p2.mean[1] - p1.mean[1];
      const mag = Math.hypot(dx, dy);
      if (mag === 0) continue;
      directions.push([dx / mag, dy / mag]);
    }
    if (directions.length < 1) return true; // no movement, consider random (stationary)
    for (let i = 0; i < directions.length; i++) {
      for (let j = i + 1; j < directions.length; j++) {
        const d1 = directions[i];
        const d2 = directions[j];
        if (!d1 || !d2) return false;
        const dot = d1[0] * d2[0] + d1[1] * d2[1];
        if (dot >= threshold) return false; // aligned, not random
      }
    }
    return true; // all pairs have low dot, directions are random
  }
  private isCentroidCentered(points: DevicePoint[], maxRadius: number): boolean {
    const centroid = computeCentroid(points.map(p => p.mean));
    for (const p of points) {
      if (distanceMeters(centroid, p.mean) > maxRadius) return false;
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
      // Capture reference coordinates from first measurement
      if (this.refLat === null || this.refLon === null) {
        this.refLat = m.lat;
        this.refLon = m.lon;
      }
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
        this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], m.variance, m.timestamp);

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
            const dist = distanceMeters(this.activeAnchor.mean, m.mean);
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
            const distance = distanceMeters(this.activeAnchor.mean, m.mean);
            if (distance < m.accuracy * profile.minDistanceAccuracyRatio) {
              const weakVariance = m.variance * profile.weakVarianceInflation;
              const weakPoint: DevicePoint = { ...m, variance: weakVariance };
              this.activeAnchor.kalmanUpdate(weakPoint, GAIN_RATE);
              this.activeAnchor.variance *= profile.anchorVarianceInflationOnNoise;
              anchorVarianceScale = profile.anchorVarianceInflationOnNoise;
              decision = 'noise-weak-update';
            } else {
              const timeFactor = Math.log1p(dtMinutes + 1);
              const score = (distance / (m.accuracy + profile.accuracyK)) * timeFactor;
              const direction = directionFromPoints(this.activeAnchor.mean, m.mean);
              this.insertOutlier({ point: m, score, direction });

              const coherence = computeCoherence(this.outliers, profile.coherenceCosineThreshold);
              const sumScore = this.outliers.reduce((acc, o) => acc + o.score, 0);
              const adjustedScore = coherence ? sumScore * (1 + profile.coherenceBonus) : sumScore;

              motionScore = score;
              motionScoreSum = adjustedScore;
              motionCoherent = coherence;
              motionDistance = distance;
              motionTimeFactor = timeFactor;
              const overrideByScore = score >= profile.singlePointScoreThreshold * profile.singlePointOverrideMultiplier;
              const overrideByAccuracy = distance >= m.accuracy * profile.singlePointAccuracyRatio;
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
                  startAnchor: this.activeAnchor!.clone(),
                  endAnchor: null,
                  path: [this.activeAnchor!.mean]
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
              // Only keep segments with meaningful path length (> 1 meter)
              const pathLength = this.computePathLength(this.currentMotionSegment.path);
              if (pathLength > 1.0) {
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
              const newAnchor = new Anchor(newMean, newVariance, m.timestamp);
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
                // Only keep segments with meaningful path length (> 1 meter)
                const pathLength = this.computePathLength(this.currentMotionSegment.path);
                if (pathLength > 1.0) {
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
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp as number, DECAY_RATE_ACTIVE) : 0 };
  }
  getDominantAnchorAt(timestamp: number): Anchor | null {
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
      })),
      currentMotionSegment: this.currentMotionSegment ? {
        startAnchor: this.currentMotionSegment.startAnchor.clone(),
        endAnchor: this.currentMotionSegment.endAnchor ? this.currentMotionSegment.endAnchor.clone() : null,
        path: structuredClone(this.currentMotionSegment.path),
      } : null,
      refLat: this.refLat,
      refLon: this.refLon,
    };
  }
  
  pruneHistory(olderThan: number) {
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
    }));
    this.currentMotionSegment = state.currentMotionSegment ? {
      startAnchor: state.currentMotionSegment.startAnchor.clone(),
      endAnchor: state.currentMotionSegment.endAnchor ? state.currentMotionSegment.endAnchor.clone() : null,
      path: structuredClone(state.currentMotionSegment.path),
    } : null;
    this.refLat = state.refLat ?? null;
    this.refLon = state.refLon ?? null;
  }
}
