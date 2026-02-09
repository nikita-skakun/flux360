import type { DevicePoint } from "@/ui/types";
import { Anchor } from "./anchor";
import { MOTION_PROFILES, distanceMeters, directionFromAnchor, computeCoherence } from "./motionDetector";
import type { MotionProfileName, MotionProfileConfig, OutlierSample } from "./motionDetector";

// Snapshot for UI/Historical view
export type EngineSnapshot = { activeAnchor: Anchor | null; closedAnchors: Anchor[]; candidateAnchor: Anchor | null; timestamp: number | null; activeConfidence: number };

// Full engine state for checkpointing
export type EngineState = {
  activeAnchor: Anchor | null;
  closedAnchors: Anchor[];
  candidateAnchor: Anchor | null;
  lastTimestamp: number | null;
  motionProfile: MotionProfileName;
  motionActive: boolean;
  motionStartTimestamp: number | null;
  outliers: OutlierSample[];
  recentMotionPoints: DevicePoint[];
  debugFrames: DebugFrame[];
  seenDebugKeys: Set<string>;
};

const DECAY_RATE_ACTIVE = 0.001;
const GAIN_RATE = 2.0;
const MIN_USABLE_CONFIDENCE = 0.1;

export type DebugDecision = 'initialized' | 'updated' | 'resisted' | 'candidate-updated' | 'candidate-created' | 'promoted' | 'active-ended' | 'none' | 'noise-weak-update' | 'motion-start' | 'motion-end';
export type DebugFrame = {
  timestamp: number;
  sourceDeviceId: number | undefined;
  motionActiveBefore: boolean;
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
  before: { mean: [number, number]; variance: number; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  after: { mean: [number, number]; variance: number; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  mahalanobis2: number | null;
  decision: DebugDecision;
};

const DEBUG_BUFFER_SIZE = 200;
const STATIONARY_MAHALANOBIS2_THRESHOLD = 25;

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
  candidateAnchor: Anchor | null = null;
  lastTimestamp: number | null = null;
  motionProfile: MotionProfileName = "person";
  motionActive: boolean = false;
  motionStartTimestamp: number | null = null;
  private outliers: OutlierSample[] = [];
  private recentMotionPoints: DevicePoint[] = [];
  // debug buffer (per-engine)
  private debugFrames: DebugFrame[] = [];
  private seenDebugKeys = new Set<string>();
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
    let lo = 0;
    let hi = this.outliers.length;
    const ts = sample.point.timestamp;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.outliers[mid]?.point.timestamp ?? 0) <= ts) lo = mid + 1;
      else hi = mid;
    }
    this.outliers.splice(lo, 0, sample);
  }
  private computeCentroid(points: DevicePoint[]): [number, number] {
    // Computes the centroid (geometric center) of points, effectively clustering them into a single representative position.
    let sumX = 0, sumY = 0;
    for (const p of points) {
      sumX += p.mean[0];
      sumY += p.mean[1];
    }
    return [sumX / points.length, sumY / points.length];
  }
  private computeAverageVariance(points: DevicePoint[]): number {
    let sum = 0;
    for (const p of points) sum += p.variance;
    return sum / points.length;
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
    const centroid = this.computeCentroid(points);
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
    if (this.debugFrames.length > DEBUG_BUFFER_SIZE) {
      this.debugFrames.sort((a, b) => a.timestamp - b.timestamp);
      this.debugFrames.splice(0, this.debugFrames.length - DEBUG_BUFFER_SIZE);
    }
  }
  processMeasurements(ms: DevicePoint[]): EngineSnapshot[] {
    const snapshots: EngineSnapshot[] = [];
    for (const m of ms) {
      const profile = this.getProfile(this.motionProfile);
      const motionActiveBefore = this.motionActive;
      let motionScore: number | null = null;
      let motionScoreSum: number | null = null;
      let motionCoherent: boolean | null = null;
      let motionDistance: number | null = null;
      let motionTimeFactor: number | null = null;
      let motionSinglePointOverride: boolean | null = null;
      let anchorVarianceScale: number | null = null;
      // capture state before
      const beforeAnchor = this.activeAnchor ? this.activeAnchor.clone() : null;
      let mahalanobis2: number | null = null;
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
          if (dist2Active < STATIONARY_MAHALANOBIS2_THRESHOLD) {
            this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
            decision = 'updated';

            this.outliers = [];
            this.candidateAnchor = null;
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
              const direction = directionFromAnchor(this.activeAnchor.mean, m.mean);
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
                this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.variance, this.motionStartTimestamp);
                this.recentMotionPoints = [];
                this.recentMotionPoints.push(m);
                this.outliers = [];
                decision = 'motion-start';
              }
            }
          }
        } else {
          if (dist2Active < STATIONARY_MAHALANOBIS2_THRESHOLD) {
            this.motionActive = false;
            this.motionStartTimestamp = null;
            this.outliers = [];
            this.candidateAnchor = null;
            this.activeAnchor.kalmanUpdate(m, GAIN_RATE);

            decision = 'motion-end';
          } else {
            this.candidateAnchor ??= new Anchor([m.mean[0], m.mean[1]], m.variance, m.timestamp);
            const dist2Candidate = this.candidateAnchor.mahalanobis2(m);
            const dist2ActiveNow = this.activeAnchor.mahalanobis2(m);
            if (dist2Candidate < STATIONARY_MAHALANOBIS2_THRESHOLD) {
              this.candidateAnchor.kalmanUpdate(m, GAIN_RATE);
              decision = 'candidate-updated';
            } else {
              this.insertOutlier({ point: m, score: 0, direction: null });
              this.candidateAnchor.kalmanUpdate(m, GAIN_RATE);
              decision = 'candidate-updated';
              if (dist2ActiveNow < STATIONARY_MAHALANOBIS2_THRESHOLD) {
                this.motionActive = false;
                this.motionStartTimestamp = null;
                this.candidateAnchor = null;
                this.outliers = [];
                this.activeAnchor.kalmanUpdate(m, GAIN_RATE);

                decision = 'motion-end';
              }
            }
            // New settling logic: Detects end of motion by evaluating a sliding window of recent points during active motion.
            // If points are consistent (spatially clustered) and directions are random (undirected noise), settle on a new anchor
            // at the centroid of the window, closing the previous anchor and resetting motion state.
            this.recentMotionPoints.push(m);
            if (this.recentMotionPoints.length > profile.motionSettleWindowSize) this.recentMotionPoints.shift();
            if (this.recentMotionPoints.length >= profile.motionSettleWindowSize && this.shouldSettle(profile)) {
              const points = this.recentMotionPoints.slice(-profile.motionSettleWindowSize);
              const newMean = this.computeCentroid(points);
              const newVariance = this.computeAverageVariance(points);
              this.activeAnchor.endTimestamp = m.timestamp;
              this.closedAnchors.push(this.activeAnchor);
              this.activeAnchor = new Anchor(newMean, newVariance, m.timestamp);
              this.motionActive = false;
              this.motionStartTimestamp = null;
              this.outliers = [];
              this.recentMotionPoints = [];
              decision = 'motion-end';
            }
          }
        }
      }

      if (!this.motionActive && this.activeAnchor && this.activeAnchor.getConfidence(m.timestamp, DECAY_RATE_ACTIVE) < MIN_USABLE_CONFIDENCE) {
        this.activeAnchor.endTimestamp = m.timestamp;
        this.closedAnchors.push(this.activeAnchor);
        this.activeAnchor = null;
        decision = 'active-ended';
      }

      // capture state after
      const afterAnchor = this.activeAnchor ? this.activeAnchor.clone() : null;

      // push debug frame (non-intrusive)
      this.pushDebugFrame({
        timestamp: m.timestamp,
        sourceDeviceId: m.sourceDeviceId,
        motionActiveBefore,
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
        before: beforeAnchor ? { mean: [beforeAnchor.mean[0], beforeAnchor.mean[1]], variance: beforeAnchor.variance, confidence: beforeAnchor.confidence, startTimestamp: beforeAnchor.startTimestamp, lastUpdateTimestamp: beforeAnchor.lastUpdateTimestamp } : null,
        after: afterAnchor ? { mean: [afterAnchor.mean[0], afterAnchor.mean[1]], variance: afterAnchor.variance, confidence: afterAnchor.confidence, startTimestamp: afterAnchor.startTimestamp, lastUpdateTimestamp: afterAnchor.lastUpdateTimestamp } : null,
        mahalanobis2,
        decision,
      });

      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp, DECAY_RATE_ACTIVE) : 0 });
    }
    return snapshots;
  }
  getCurrentSnapshot(): EngineSnapshot {
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp as number, DECAY_RATE_ACTIVE) : 0 };
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
      candidateAnchor: this.candidateAnchor ? this.candidateAnchor.clone() : null,
      lastTimestamp: this.lastTimestamp,
      motionProfile: this.motionProfile,
      motionActive: this.motionActive,
      motionStartTimestamp: this.motionStartTimestamp,
      outliers: JSON.parse(JSON.stringify(this.outliers)) as OutlierSample[], // Deep copy outliers
      recentMotionPoints: JSON.parse(JSON.stringify(this.recentMotionPoints)) as DevicePoint[], // Deep copy points
      debugFrames: [...this.debugFrames], // Shallow copy array of frames (frames themselves are immutable-ish once created)
      seenDebugKeys: new Set(this.seenDebugKeys),
    };
  }
  restoreSnapshot(state: EngineState): void {
    this.activeAnchor = state.activeAnchor ? state.activeAnchor.clone() : null;
    this.closedAnchors = state.closedAnchors.map(a => a.clone());
    this.candidateAnchor = state.candidateAnchor ? state.candidateAnchor.clone() : null;
    this.lastTimestamp = state.lastTimestamp;
    this.motionProfile = state.motionProfile;
    this.motionActive = state.motionActive;
    this.motionStartTimestamp = state.motionStartTimestamp;
    this.outliers = JSON.parse(JSON.stringify(state.outliers)) as OutlierSample[];
    this.recentMotionPoints = JSON.parse(JSON.stringify(state.recentMotionPoints)) as DevicePoint[];
    this.debugFrames = [...state.debugFrames];
    this.seenDebugKeys = new Set(state.seenDebugKeys);
  }
}
