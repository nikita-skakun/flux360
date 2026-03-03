import { Anchor } from "./anchor";
import { distanceSquared, directionFromPoints, computeCentroid } from "@/util/geo";
import { MOTION_PROFILES, computeCoherence, type MotionProfileConfig, type OutlierSample } from "./motionDetector";
import { fromWebMercator, WORLD_R } from "@/util/webMercator";
import type { DevicePoint, MotionProfileName, MotionSegment, Timestamp, Vec2 } from "@/types";

// Snapshot for UI/Historical view
export type EngineSnapshot = { activeAnchor: Anchor; closedAnchors: Anchor[]; timestamp: Timestamp | null; activeConfidence: number };

// Full engine state for checkpointing
export type EngineState = {
  activeAnchor: Anchor | null;
  closedAnchors: Anchor[];
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
  motionStartTimestamp: Timestamp | null;
  outlierCount: number;
  motionScore: number | null;
  motionScoreSum: number | null;
  motionCoherent: boolean | null;
  motionDistance: number | null;
  motionTimeFactor: number | null;
  motionSinglePointOverride: boolean | null;
  anchorVarianceScale: number | null;
  measurement: { geo: Vec2; accuracy: number; mean: Vec2; variance: number; };
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
  private outliers: OutlierSample[] = [];
  private recentMotionPoints: DevicePoint[] = [];
  // debug buffer (per-engine)
  private debugFrames: DebugFrame[] = [];
  private seenDebugKeys = new Set<string>();
  motionSegments: MotionSegment[] = [];
  currentMotionSegment: MotionSegment | null = null;

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
    for (const p of points) sum += p.accuracy * p.accuracy;
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

  private arePointsConsistent(points: DevicePoint[], centroid: Vec2, threshold: number): boolean {
    if (points.length < 2) return true;
    for (const p of points) {
      const dx = p.mean[0] - centroid[0];
      const dy = p.mean[1] - centroid[1];
      const mahal = (dx * dx + dy * dy) / (p.accuracy * p.accuracy);
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

  private isCentroidCentered(points: DevicePoint[], centroid: Vec2, maxRadius: number): boolean {
    const radiusSquared = maxRadius * maxRadius;
    for (const p of points) {
      if (distanceSquared(centroid, p.mean) > radiusSquared) return false;
    }
    return true;
  }

  private shouldSettle(profile: MotionProfileConfig): boolean {
    if (this.recentMotionPoints.length < profile.motionSettleWindowSize) return false;
    const points = this.recentMotionPoints.slice(-profile.motionSettleWindowSize);
    const centroid = computeCentroid(points.map(p => p.mean));
    const consistent = this.arePointsConsistent(points, centroid, profile.motionSettleMahalanobisThreshold);
    const randomDir = this.areDirectionsRandom(points, profile.motionSettleDirectionThreshold);
    const centered = this.isCentroidCentered(points, centroid, profile.maxCentroidRadiusMeters);
    return consistent && randomDir && centered;
  }

  private pushDebugFrame(frame: DebugFrame) {
    const key = `${frame.timestamp}:${frame.measurement.geo[0]}:${frame.measurement.geo[1]}:${frame.measurement.accuracy}:${frame.sourceDeviceId ?? ''} `;
    if (this.seenDebugKeys.has(key)) return;
    this.seenDebugKeys.add(key);
    this.debugFrames.push(frame);
  }

  processMeasurements(ms: DevicePoint[], returnSnapshots: boolean = false): EngineSnapshot[] {
    const snapshots: EngineSnapshot[] = [];
    for (const m of ms) {
      // ... (rest of the logic inside the loop, preserving original functionality)
      // For brevity in replacement, I'll keep the core loop intact but optimized
      // Note: The logic between lines 185-375 remains mostly same except for distSq optimizations applied above
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
        const initialVariance = m.accuracy * m.accuracy;
        this.activeAnchor = new Anchor([m.mean[0], m.mean[1]], initialVariance, m.timestamp, m.timestamp);

        this.outliers = [];
        this.recentMotionPoints = [];
        decision = 'initialized';
      } else {
        const mVariance = m.accuracy * m.accuracy;
        const dist2Active = this.activeAnchor.mahalanobis2(m.mean, mVariance);
        mahalanobis2 = dist2Active;

        if (!this.currentMotionSegment) {
          if (dist2Active < profile.stationaryMahalanobisThreshold) {
            // Detect stationary drift: when reports consistently fall outside the anchor's accuracy circle,
            // we inflate the anchor's variance to allow it to move toward the new position.
            const distSq = distanceSquared(this.activeAnchor.mean, m.mean);
            const anchorRadius = Math.sqrt(this.activeAnchor.variance);
            const dist = Math.sqrt(distSq);
            const reportRadius = m.accuracy;
            const separation = dist - (anchorRadius + reportRadius);
            trendSeparation = separation;

            if (separation > 0) {
              // Accuracy circles don't overlap: inflate variance proportionally to separation.
              // Division by variance (accuracy²) ensures inaccurate reports have minimal impact.
              const inflation = 1 + (separation / (m.accuracy * m.accuracy)) * profile.trendVarianceInflation;
              this.activeAnchor.variance *= inflation;
              this.activeAnchor.confidence /= inflation;
            }

            this.activeAnchor.kalmanUpdate(m.mean, m.accuracy, m.accuracy * m.accuracy, m.timestamp, GAIN_RATE);
            decision = 'updated';

            this.outliers = [];
          } else {
            decision = 'resisted';
            const lastConfirm = this.activeAnchor.lastUpdateTimestamp ?? m.timestamp;
            const dtMinutes = Math.max(0, (m.timestamp - lastConfirm) / 60000);
            const distSq = distanceSquared(this.activeAnchor.mean, m.mean);
            const anchorVariance = this.activeAnchor.variance;
            if (distSq < m.accuracy * m.accuracy * profile.minDistanceAccuracyRatio * profile.minDistanceAccuracyRatio || distSq <= (Math.sqrt(anchorVariance) + m.accuracy) ** 2) {
              // Center is within the noise-gate radius, OR the GPS circles still overlap —
              // Both cases are geometrically consistent with being stationary.
              const weakVariance = m.accuracy * m.accuracy * profile.weakVarianceInflation;
              this.activeAnchor.kalmanUpdate(m.mean, m.accuracy, weakVariance, m.timestamp, GAIN_RATE);
              this.activeAnchor.variance *= profile.anchorVarianceInflationOnNoise;
              anchorVarianceScale = profile.anchorVarianceInflationOnNoise;
              decision = 'noise-weak-update';
            } else {
              const distToMean = Math.sqrt(distSq);
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
                const motionStartTimestamp = (this.outliers[0]?.point.timestamp ?? m.timestamp);
                this.recentMotionPoints = [];
                this.recentMotionPoints.push(m);
                this.outliers = [];
                decision = 'motion-start';
                // Start a new motion segment - clone the anchor to preserve its state
                this.currentMotionSegment = {
                  startAnchor: this.activeAnchor.clone(),
                  endAnchor: null,
                  path: [this.activeAnchor.mean],
                  startTime: motionStartTimestamp,
                  endTime: null,
                  distance: 0,
                  duration: 0,
                };
              }
            }
          }
        } else {
          const dist2Active = this.activeAnchor.mahalanobis2(m.mean, m.accuracy * m.accuracy);
          if (dist2Active < profile.stationaryMahalanobisThreshold) {
            this.outliers = [];
            this.activeAnchor.kalmanUpdate(m.mean, m.accuracy, m.accuracy * m.accuracy, m.timestamp, GAIN_RATE);

            decision = 'motion-end';
            // Finalize motion segment
            if (this.currentMotionSegment) {
              // Clone the anchor to preserve its state at motion end
              this.currentMotionSegment.endAnchor = this.activeAnchor.clone();
              this.currentMotionSegment.path.push(this.activeAnchor.mean);
              this.currentMotionSegment.endTime = m.timestamp;
              this.currentMotionSegment.duration = this.currentMotionSegment.endTime - this.currentMotionSegment.startTime;
              this.currentMotionSegment.distance = this.computePathLength(this.currentMotionSegment.path);

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
        motionStartTimestamp: this.currentMotionSegment?.startTime ?? null,
        outlierCount: this.outliers.length,
        motionScore,
        motionScoreSum,
        motionCoherent,
        motionDistance,
        motionTimeFactor,
        motionSinglePointOverride,
        anchorVarianceScale,
        measurement: { geo: m.geo, accuracy: m.accuracy, mean: [m.mean[0], m.mean[1]], variance: m.accuracy * m.accuracy },
        anchor: afterAnchor ? { mean: [afterAnchor.mean[0], afterAnchor.mean[1]], variance: afterAnchor.variance, confidence: afterAnchor.confidence, startTimestamp: afterAnchor.startTimestamp, lastUpdateTimestamp: afterAnchor.lastUpdateTimestamp } : null,
        mahalanobis2,
        decision,
        trendSeparation,
      });

      this.lastTimestamp = m.timestamp;
      if (this.activeAnchor && returnSnapshots) {
        snapshots.push({
          activeAnchor: this.activeAnchor.clone(),
          closedAnchors: this.closedAnchors.map(a => a.clone()),
          timestamp: m.timestamp,
          activeConfidence: this.activeAnchor.getConfidence(m.timestamp, DECAY_RATE_ACTIVE)
        });
      }
    }
    return snapshots;
  }

  getCurrentSnapshot(): EngineSnapshot | null {
    if (!this.activeAnchor) return null;
    return {
      activeAnchor: this.activeAnchor.clone(),
      closedAnchors: this.closedAnchors.map(a => a.clone()),
      timestamp: this.lastTimestamp,
      activeConfidence: this.activeAnchor.getConfidence(this.lastTimestamp ?? Date.now() as Timestamp, DECAY_RATE_ACTIVE)
    };
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
      outliers: [...this.outliers],
      recentMotionPoints: [...this.recentMotionPoints],
      debugFrames: [...this.debugFrames],
      seenDebugKeys: new Set(this.seenDebugKeys),
      motionSegments: this.motionSegments.map(s => ({
        startAnchor: s.startAnchor.clone(),
        endAnchor: s.endAnchor ? s.endAnchor.clone() : null,
        path: [...s.path],
        startTime: s.startTime,
        endTime: s.endTime,
        distance: s.distance,
        duration: s.duration,
      })),
      currentMotionSegment: this.currentMotionSegment ? {
        startAnchor: this.currentMotionSegment.startAnchor.clone(),
        endAnchor: this.currentMotionSegment.endAnchor ? this.currentMotionSegment.endAnchor.clone() : null,
        path: [...this.currentMotionSegment.path],
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

  refineHistory(profileConfig: MotionProfileConfig) {
    if (this.closedAnchors.length < 2) return;

    // 1. Trim start and end points of motion segments
    for (const segment of this.motionSegments) {
      if (!segment.endAnchor) continue; // Skip active segment

      const originalLength = segment.path.length;
      if (originalLength <= 2) continue;

      // Trim from start (points belonging to startAnchor)
      const startRadiusSq = segment.startAnchor.variance; // Approx radius² from variance
      let startIndex = 0;
      while (startIndex < segment.path.length - 1) {
        if (distanceSquared(segment.startAnchor.mean, segment.path[startIndex]!) <= startRadiusSq * 1.5) { // Lenient boundary
          startIndex++;
        } else {
          break;
        }
      }

      // Trim from end (points belonging to endAnchor)
      const endRadiusSq = segment.endAnchor.variance;
      let endIndex = segment.path.length - 1;
      while (endIndex > startIndex) {
        if (distanceSquared(segment.endAnchor.mean, segment.path[endIndex]!) <= endRadiusSq * 1.5) {
          endIndex--;
        } else {
          break;
        }
      }

      if (startIndex > 0 || endIndex < segment.path.length - 1) {
        segment.path = segment.path.slice(startIndex, endIndex + 1);

        // Recalculate distance
        segment.distance = this.computePathLength(segment.path);
      }
    }

    // 2. Merge adjacent anchors & drop transient ones
    let i = 0;
    while (i < this.closedAnchors.length - 1) {
      const current = this.closedAnchors[i]!;
      const next = this.closedAnchors[i + 1]!;

      // Find the connecting motion segment
      const segmentIndex = this.motionSegments.findIndex(s => s.startAnchor.startTimestamp === current.startTimestamp && s.endAnchor?.startTimestamp === next.startTimestamp);
      if (segmentIndex === -1) {
        i++;
        continue;
      }

      const segment = this.motionSegments[segmentIndex]!;

      // Calculate combined duration
      const currentDuration = current.lastUpdateTimestamp - current.startTimestamp;

      const distSq = distanceSquared(current.mean, next.mean);
      const mergeRadius = Math.max(profileConfig.retrospectiveMaxStationaryRadius, (Math.sqrt(current.variance) + Math.sqrt(next.variance)) * 0.6);
      const mergeRadiusSquared = mergeRadius * mergeRadius;

      // Calculate path extent to ensure it didn't wander far
      let maxDistSqFromCenter = 0;
      const center: Vec2 = [(current.mean[0] + next.mean[0]) / 2, (current.mean[1] + next.mean[1]) / 2];
      for (const p of segment.path) {
        const dSq = distanceSquared(center, p);
        if (dSq > maxDistSqFromCenter) maxDistSqFromCenter = dSq;
      }
      const midExtentSq = maxDistSqFromCenter * 4; // Approx diameter²

      const isShortAnchor = currentDuration < profileConfig.retrospectiveMinStationaryDuration;
      const isSpatiallyClose = distSq < mergeRadiusSquared && midExtentSq < mergeRadiusSquared;
      const isInsignificantSegment = segment.distance < Math.max(profileConfig.retrospectiveMaxStationaryRadius, Math.sqrt((current.variance + next.variance) / 2) * 1.5);

      if (isShortAnchor || isSpatiallyClose || isInsignificantSegment) {
        // Merge `next` into `current`
        const weightCurrent = currentDuration || 1;
        const weightNext = (next.lastUpdateTimestamp - next.startTimestamp) || 1;

        const newMean: Vec2 = [
          (current.mean[0] * weightCurrent + next.mean[0] * weightNext) / (weightCurrent + weightNext),
          (current.mean[1] * weightCurrent + next.mean[1] * weightNext) / (weightCurrent + weightNext)
        ];

        current.mean = newMean;
        current.endTimestamp = next.endTimestamp;
        current.lastUpdateTimestamp = next.lastUpdateTimestamp;
        current.variance = (current.variance * weightCurrent + next.variance * weightNext) / (weightCurrent + weightNext);

        // Remove `next` anchor
        this.closedAnchors.splice(i + 1, 1);

        // Remove the connecting segment
        this.motionSegments.splice(segmentIndex, 1);

        // If there's a subsequent segment that started from `next`, update its startAnchor
        const nextSegment = this.motionSegments.find(s => s.startAnchor.startTimestamp === next.startTimestamp);
        if (nextSegment) {
          nextSegment.startAnchor = current;
        }
      } else {
        i++;
      }
    }

    // Also check merge with activeAnchor
    if (this.activeAnchor && this.closedAnchors.length > 0) {
      const current = this.closedAnchors[this.closedAnchors.length - 1]!;
      const next = this.activeAnchor;

      const segmentIndex = this.motionSegments.findIndex(s => s.startAnchor.startTimestamp === current.startTimestamp && s.endAnchor?.startTimestamp === next.startTimestamp);
      if (segmentIndex !== -1) {
        const segment = this.motionSegments[segmentIndex]!;
        const currentDuration = current.lastUpdateTimestamp - current.startTimestamp;

        const distSq = distanceSquared(current.mean, next.mean);
        const mergeRadius = Math.max(profileConfig.retrospectiveMaxStationaryRadius, (Math.sqrt(current.variance) + Math.sqrt(next.variance)) * 0.6);
        const mergeRadiusSquared = mergeRadius * mergeRadius;

        let maxDistSqFromCenter = 0;
        const center: Vec2 = [(current.mean[0] + next.mean[0]) / 2, (current.mean[1] + next.mean[1]) / 2];
        for (const p of segment.path) {
          const dSq = distanceSquared(center, p);
          if (dSq > maxDistSqFromCenter) maxDistSqFromCenter = dSq;
        }
        const midExtentSq = maxDistSqFromCenter * 4;

        const isShortAnchor = currentDuration < profileConfig.retrospectiveMinStationaryDuration;
        const isSpatiallyClose = distSq < mergeRadiusSquared && midExtentSq < mergeRadiusSquared;
        const isInsignificantSegment = segment.distance < Math.max(profileConfig.retrospectiveMaxStationaryRadius, Math.sqrt((current.variance + next.variance) / 2) * 1.5);

        if (isShortAnchor || isSpatiallyClose || isInsignificantSegment) {
          const weightCurrent = currentDuration || 1;
          const weightNext = (next.lastUpdateTimestamp - next.startTimestamp) || 1;

          const newMean: Vec2 = [
            (current.mean[0] * weightCurrent + next.mean[0] * weightNext) / (weightCurrent + weightNext),
            (current.mean[1] * weightCurrent + next.mean[1] * weightNext) / (weightCurrent + weightNext)
          ];

          next.mean = newMean;
          next.startTimestamp = current.startTimestamp; // Inherit older start time
          next.variance = (current.variance * weightCurrent + next.variance * weightNext) / (weightCurrent + weightNext);

          this.closedAnchors.pop(); // Remove `current`
          this.motionSegments.splice(segmentIndex, 1);

          // Find any incoming segments to `current` and point them to `next`
          const incomingSegment = this.motionSegments.find(s => s.endAnchor?.startTimestamp === current.startTimestamp);
          if (incomingSegment) {
            incomingSegment.endAnchor = next;
          }
        }
      }
    }
  }

  restoreSnapshot(state: EngineState): void {
    this.activeAnchor = state.activeAnchor ? state.activeAnchor.clone() : null;
    this.closedAnchors = state.closedAnchors.map(a => a.clone());
    this.outliers = [...state.outliers];
    this.recentMotionPoints = [...state.recentMotionPoints];
    this.debugFrames = [...state.debugFrames];
    this.seenDebugKeys = new Set(state.seenDebugKeys);
    this.motionSegments = state.motionSegments.map(s => ({
      startAnchor: s.startAnchor.clone(),
      endAnchor: s.endAnchor ? s.endAnchor.clone() : null,
      path: [...s.path],
      startTime: s.startTime,
      endTime: s.endTime,
      distance: s.distance,
      duration: s.duration,
    }));
    this.currentMotionSegment = state.currentMotionSegment ? {
      startAnchor: state.currentMotionSegment.startAnchor.clone(),
      endAnchor: state.currentMotionSegment.endAnchor ? state.currentMotionSegment.endAnchor.clone() : null,
      path: [...state.currentMotionSegment.path],
      startTime: state.currentMotionSegment.startTime,
      endTime: state.currentMotionSegment.endTime,
      distance: state.currentMotionSegment.distance,
      duration: state.currentMotionSegment.duration,
    } : null;
  }
}
