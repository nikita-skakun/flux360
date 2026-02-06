import type { DevicePoint } from "@/ui/types";
import { Anchor } from "./anchor";
import type { Cov2, Vec2 } from "@/ui/types";

export type MotionProfileName = "person" | "car";

type MotionProfileConfig = {
  motionScoreThreshold: number;
  singlePointScoreThreshold: number;
  singlePointOverrideMultiplier: number;
  singlePointAccuracyRatio: number;
  minDistanceAccuracyRatio: number;
  coherenceCosineThreshold: number;
  coherenceBonus: number;
  accuracyK: number;
  settleWindowSize: number;
  settleMaxSpreadMeters: number;
  weakUpdateGain: number;
  weakCovInflation: number;
  anchorCovInflationOnNoise: number;
};

const MOTION_PROFILES: Record<MotionProfileName, MotionProfileConfig> = {
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

export type EngineSnapshot = { activeAnchor: Anchor | null; closedAnchors: Anchor[]; candidateAnchor: Anchor | null; timestamp: number; activeConfidence: number };

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
  lastAnchorConfirmTimestamp: number | null;
  outlierCount: number;
  motionScore: number | null;
  motionScoreSum: number | null;
  motionCoherent: boolean | null;
  motionDistance: number | null;
  motionTimeFactor: number | null;
  motionSinglePointOverride: boolean | null;
  anchorCovarianceScale: number | null;
  measurement: { lat: number; lon: number; accuracy: number; mean: [number, number]; cov: [number, number, number]; };
  before: { mean: [number, number]; cov: [number, number, number]; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  after: { mean: [number, number]; cov: [number, number, number]; confidence: number; startTimestamp: number; lastUpdateTimestamp: number } | null;
  mahalanobis2: number | null;
  decision: DebugDecision;
};

const DEBUG_BUFFER_SIZE = 200;
const STATIONARY_MAHALANOBIS2_THRESHOLD = 25;

type OutlierSample = {
  point: DevicePoint;
  score: number;
  direction: Vec2 | null;
};

export class Engine {
  activeAnchor: Anchor | null = null;
  closedAnchors: Anchor[] = [];
  candidateAnchor: Anchor | null = null;
  lastTimestamp: number | null = null;
  motionProfile: MotionProfileName = "person";
  motionActive: boolean = false;
  motionStartTimestamp: number | null = null;
  lastAnchorConfirmTimestamp: number | null = null;
  private outliers: OutlierSample[] = [];
  private settlePoints: DevicePoint[] = [];

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

  private scaleCov(cov: Cov2, factor: number): Cov2 {
    return [cov[0] * factor, cov[1] * factor, cov[2] * factor];
  }

  private distanceMeters(a: Vec2, b: Vec2): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.hypot(dx, dy);
  }

  private directionFromAnchor(anchor: Vec2, point: Vec2): Vec2 | null {
    const dx = point[0] - anchor[0];
    const dy = point[1] - anchor[1];
    const mag = Math.hypot(dx, dy);
    if (mag === 0) return null;
    return [dx / mag, dy / mag];
  }

  private dot(a: Vec2, b: Vec2): number {
    return a[0] * b[0] + a[1] * b[1];
  }

  private computeCoherence(outliers: OutlierSample[], threshold: number): boolean {
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
      if (this.dot(o.direction, avg) < threshold) return false;
    }
    return true;
  }

  private insertOutlier(sample: OutlierSample) {
    if (this.lastAnchorConfirmTimestamp != null && sample.point.timestamp <= this.lastAnchorConfirmTimestamp) return;
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

  private insertSettlePoint(p: DevicePoint) {
    let lo = 0;
    let hi = this.settlePoints.length;
    const ts = p.timestamp;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.settlePoints[mid]?.timestamp ?? 0) <= ts) lo = mid + 1;
      else hi = mid;
    }
    this.settlePoints.splice(lo, 0, p);
  }

  private hasRecentOutliers(thresholdTimestamp: number): boolean {
    for (let i = this.outliers.length - 1; i >= 0; i--) {
      const ts = this.outliers[i]?.point.timestamp ?? 0;
      if (ts >= thresholdTimestamp) return true;
      if (ts < thresholdTimestamp) break;
    }
    return false;
  }

  private settleClusterStable(profile: MotionProfileConfig): boolean {
    if (this.settlePoints.length < profile.settleWindowSize) return false;
    const recent = this.settlePoints.slice(-profile.settleWindowSize);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of recent) {
      const x = p.mean[0];
      const y = p.mean[1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const spread = Math.hypot(maxX - minX, maxY - minY);
    return spread <= profile.settleMaxSpreadMeters;
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
      let anchorCovarianceScale: number | null = null;
      // capture state before
      const beforeAnchor = this.activeAnchor ? this.activeAnchor.clone() : null;
      let mahalanobis2: number | null = null;
      let decision: DebugDecision = 'none';

      if (this.activeAnchor === null) {
        // Initialize with the first measurement
        this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
        this.lastAnchorConfirmTimestamp = m.timestamp;
        this.motionActive = false;
        this.motionStartTimestamp = null;
        this.outliers = [];
        this.settlePoints = [];
        decision = 'initialized';
      } else {
        const dist2Active = this.activeAnchor.mahalanobis2(m);
        mahalanobis2 = dist2Active;

        if (!this.motionActive) {
          if (dist2Active < STATIONARY_MAHALANOBIS2_THRESHOLD) {
            this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
            decision = 'updated';
            this.lastAnchorConfirmTimestamp = m.timestamp;
            this.outliers = [];
            this.settlePoints = [];
            this.candidateAnchor = null;
          } else {
            decision = 'resisted';
            const lastConfirm = this.lastAnchorConfirmTimestamp ?? this.activeAnchor.lastUpdateTimestamp ?? m.timestamp;
            const dtMinutes = Math.max(0, (m.timestamp - lastConfirm) / 60000);
            const distance = this.distanceMeters(this.activeAnchor.mean, m.mean);
            if (distance < m.accuracy * profile.minDistanceAccuracyRatio) {
              const weakCov = this.scaleCov(m.cov, profile.weakCovInflation);
              const weakPoint: DevicePoint = { ...m, cov: weakCov };
              this.activeAnchor.kalmanUpdate(weakPoint, GAIN_RATE * profile.weakUpdateGain);
              this.activeAnchor.cov = this.scaleCov(this.activeAnchor.cov, profile.anchorCovInflationOnNoise);
              anchorCovarianceScale = profile.anchorCovInflationOnNoise;
              decision = 'noise-weak-update';
            } else {
              const timeFactor = Math.log1p(dtMinutes + 1);
              const score = (distance / (m.accuracy + profile.accuracyK)) * timeFactor;
              const direction = this.directionFromAnchor(this.activeAnchor.mean, m.mean);
              this.insertOutlier({ point: m, score, direction });

              const coherence = this.computeCoherence(this.outliers, profile.coherenceCosineThreshold);
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
                this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
                this.settlePoints = [];
                this.outliers = [];
                decision = 'motion-start';
              } else {
                const weakCov = this.scaleCov(m.cov, profile.weakCovInflation);
                const weakPoint: DevicePoint = { ...m, cov: weakCov };
                this.activeAnchor.kalmanUpdate(weakPoint, GAIN_RATE * profile.weakUpdateGain);
                this.activeAnchor.cov = this.scaleCov(this.activeAnchor.cov, profile.anchorCovInflationOnNoise);
                anchorCovarianceScale = profile.anchorCovInflationOnNoise;
                decision = 'noise-weak-update';
              }
            }
          }
        } else {
          if (dist2Active < STATIONARY_MAHALANOBIS2_THRESHOLD) {
            this.motionActive = false;
            this.motionStartTimestamp = null;
            this.outliers = [];
            this.settlePoints = [];
            this.candidateAnchor = null;
            this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
            this.lastAnchorConfirmTimestamp = m.timestamp;
            decision = 'motion-end';
          } else {
            if (!this.candidateAnchor) {
              this.candidateAnchor = new Anchor([m.mean[0], m.mean[1]], m.cov, m.timestamp);
            }
            const dist2Candidate = this.candidateAnchor.mahalanobis2(m);
            const dist2ActiveNow = this.activeAnchor.mahalanobis2(m);
            if (dist2Candidate < STATIONARY_MAHALANOBIS2_THRESHOLD) {
              this.candidateAnchor.kalmanUpdate(m, GAIN_RATE);
              this.insertSettlePoint(m);
              if (this.settleClusterStable(profile) && !this.hasRecentOutliers((this.settlePoints[0]?.timestamp ?? m.timestamp) - 1)) {
                this.activeAnchor.endTimestamp = m.timestamp;
                this.closedAnchors.push(this.activeAnchor);
                this.activeAnchor = this.candidateAnchor;
                this.candidateAnchor = null;
                this.motionActive = false;
                this.motionStartTimestamp = null;
                this.outliers = [];
                this.settlePoints = [];
                this.lastAnchorConfirmTimestamp = m.timestamp;
                decision = 'motion-end';
              } else {
                decision = 'candidate-updated';
              }
            } else {
              this.settlePoints = [];
              this.insertOutlier({ point: m, score: 0, direction: null });
              this.candidateAnchor.kalmanUpdate(m, GAIN_RATE);
              decision = 'candidate-updated';
              if (dist2ActiveNow < STATIONARY_MAHALANOBIS2_THRESHOLD) {
                this.motionActive = false;
                this.motionStartTimestamp = null;
                this.candidateAnchor = null;
                this.outliers = [];
                this.settlePoints = [];
                this.activeAnchor.kalmanUpdate(m, GAIN_RATE);
                this.lastAnchorConfirmTimestamp = m.timestamp;
                decision = 'motion-end';
              }
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
        lastAnchorConfirmTimestamp: this.lastAnchorConfirmTimestamp,
        outlierCount: this.outliers.length,
        motionScore,
        motionScoreSum,
        motionCoherent,
        motionDistance,
        motionTimeFactor,
        motionSinglePointOverride,
        anchorCovarianceScale,
        measurement: { lat: m.lat, lon: m.lon, accuracy: m.accuracy, mean: [m.mean[0], m.mean[1]], cov: [m.cov[0], m.cov[1], m.cov[2]] },
        before: beforeAnchor ? { mean: [beforeAnchor.mean[0], beforeAnchor.mean[1]], cov: [beforeAnchor.cov[0], beforeAnchor.cov[1], beforeAnchor.cov[2]], confidence: beforeAnchor.confidence, startTimestamp: beforeAnchor.startTimestamp, lastUpdateTimestamp: beforeAnchor.lastUpdateTimestamp } : null,
        after: afterAnchor ? { mean: [afterAnchor.mean[0], afterAnchor.mean[1]], cov: [afterAnchor.cov[0], afterAnchor.cov[1], afterAnchor.cov[2]], confidence: afterAnchor.confidence, startTimestamp: afterAnchor.startTimestamp, lastUpdateTimestamp: afterAnchor.lastUpdateTimestamp } : null,
        mahalanobis2,
        decision,
      });

      this.lastTimestamp = m.timestamp;
      snapshots.push({ activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp, DECAY_RATE_ACTIVE) : 0 });
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot {
    return { activeAnchor: this.activeAnchor, closedAnchors: [...this.closedAnchors], candidateAnchor: this.candidateAnchor, timestamp: this.lastTimestamp!, activeConfidence: this.activeAnchor ? this.activeAnchor.getConfidence(this.lastTimestamp!, DECAY_RATE_ACTIVE) : 0 };
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
}
