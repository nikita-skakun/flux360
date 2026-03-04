import { haversineDistance } from "@/util/geo";
import { MOTION_PROFILES, ENGINE_WINDOW_SIZE, PENDING_THRESHOLD, MIN_PATH_POINTS, HARD_BREAKOUT_DISTANCE, SETTLING_WINDOW_CAP, DEBUG_FRAME_CAP, type MotionProfileConfig } from "./motionDetector";
import { fromWebMercator } from "@/util/webMercator";
import { smoothPath } from "@/util/pathSmoothing";
import type { DevicePoint, MotionProfileName, Timestamp, Vec2, EngineEvent, EngineDraft, StationaryDraft, MotionDraft, MotionEvent } from "@/types";

export type EngineSnapshot = {
  draft: EngineDraft | null;
  closed: EngineEvent[];
  timestamp: Timestamp | null;
  activeConfidence: number;
};

export type EngineState = {
  draft: EngineDraft | null;
  closed: EngineEvent[];
  debugFrames: DebugFrame[];
  seenDebugKeys: Set<string>;
};

export type DebugDecision = 'stationary' | 'pending' | 'motion' | 'settled-significant' | 'settled-absorbed';
export type DebugFrame = {
  timestamp: Timestamp;
  decision: DebugDecision;
  point: Vec2 | null;
  mean: Vec2 | null;
  variance: number | null;
  mahalanobis2: number | null;
  pendingCount: number;
  draftType: 'stationary' | 'motion' | 'none';
};

export class Engine {
  draft: EngineDraft | null = null;
  closed: EngineEvent[] = [];
  lastTimestamp: Timestamp | null = null;
  public motionProfile: MotionProfileName = "person";

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

  private getProfile(): MotionProfileConfig {
    return MOTION_PROFILES[this.motionProfile];
  }

  processMeasurements(points: DevicePoint[]) {
    for (const p of points) {
      this.lastTimestamp = p.timestamp;
      this.step(p);
    }
  }

  private step(p: DevicePoint) {
    const profile = this.getProfile();

    // Initial state: Start as stationary
    if (!this.draft) {
      this.draft = {
        type: 'stationary',
        start: p.timestamp,
        stationaryStartAnchor: p.mean,
        recent: [p],
        pending: []
      };
      this.recordDebug(p, 'stationary');
      return;
    }

    if (this.draft.type === 'stationary') {
      this.handleStationary(this.draft, p, profile);
    } else {
      this.handleMotion(this.draft, p, profile);
    }
  }

  private handleStationary(draft: StationaryDraft, p: DevicePoint, profile: MotionProfileConfig) {
    const stats = this.computeStats(draft.recent);
    const m2 = this.computeMahalanobis2(p.mean, stats.mean, stats.variance);

    // Hard breakout check: if we are too far from the ORIGINAL anchor, force motion
    const distFromStart = haversineDistance(fromWebMercator(p.mean), fromWebMercator(draft.stationaryStartAnchor));
    const isFar = distFromStart > HARD_BREAKOUT_DISTANCE;

    if (m2 < profile.stationaryMahalanobisThreshold && !isFar) {
      // It's stationary
      draft.recent.push(p);
      if (draft.recent.length > ENGINE_WINDOW_SIZE) draft.recent.shift();
      draft.pending = []; // Reset hysteresis
      this.recordDebug(p, 'stationary', stats.mean, stats.variance, m2);
    } else {
      // Potential motion
      draft.pending.push(p);
      this.recordDebug(p, 'pending', stats.mean, stats.variance, m2);

      if (draft.pending.length >= PENDING_THRESHOLD) {
        // Alignment Gate: Transition only if points are coherent
        const directions: Vec2[] = draft.pending.map(pt => {
          const dx = pt.mean[0] - stats.mean[0];
          const dy = pt.mean[1] - stats.mean[1];
          const mag = Math.hypot(dx, dy);
          return mag > 0 ? [dx / mag, dy / mag] as Vec2 : [0, 0] as Vec2;
        });

        const isCoherent = this.checkCoherence(directions, profile.coherenceCosineThreshold);
        const anyPendingFar = draft.pending.some(pt => haversineDistance(fromWebMercator(pt.mean), fromWebMercator(draft.stationaryStartAnchor)) > HARD_BREAKOUT_DISTANCE);

        if (isCoherent || anyPendingFar) {
          // Transition to Motion
          const startTimestamp = draft.pending[0]!.timestamp;
          this.draft = {
            type: 'motion',
            start: startTimestamp,
            stationaryCutoff: startTimestamp,
            predecessor: draft,
            startAnchor: stats.mean,
            path: [...draft.pending],
            recent: [draft.pending[draft.pending.length - 1]!]
          };
        } else {
          // Mushy noise. Merge oldest pending into recent to prevent buffer bloat
          const first = draft.pending.shift()!;
          draft.recent.push(first);
          if (draft.recent.length > ENGINE_WINDOW_SIZE) draft.recent.shift();
          this.recordDebug(p, 'stationary'); // Re-classify as stationary mush
        }
      }
    }
  }

  private handleMotion(draft: MotionDraft, p: DevicePoint, profile: MotionProfileConfig) {
    draft.path.push(p);
    draft.recent.push(p);

    // Cap settling window by count to handle sparse GPS data.
    // checkSettled's own duration check handles the time constraint.
    while (draft.recent.length > SETTLING_WINDOW_CAP) {
      draft.recent.shift();
    }

    const isSettled = this.checkSettled(draft, profile);

    if (!isSettled) {
      this.recordDebug(p, 'motion');
      return;
    }

    // Settled! Decide if significant or noise
    const settleStart = draft.recent[0]!.timestamp;
    const settleStats = this.computeStats(draft.recent);
    const totalDistance = this.computePathLength(draft.path);
    const startEndDist = haversineDistance(fromWebMercator(draft.startAnchor), fromWebMercator(settleStats.mean));
    const maxDev = this.maxDeviation(draft.path, draft.startAnchor);

    const settleEnd = draft.recent[draft.recent.length - 1]!.timestamp;
    const settleDurationSeconds = (settleEnd - draft.start) / 1000;
    const avgRoadSpeed = settleDurationSeconds > 0 ? totalDistance / settleDurationSeconds : 0;
    const efficiency = totalDistance > 0 ? startEndDist / totalDistance : 0;

    const minSignificantDist = 8 * profile.maxStationaryRadius;
    const maxLoopDev = 3 * profile.maxStationaryRadius;

    const significantDisplacement = startEndDist > 5 * profile.maxStationaryRadius;
    const significantLoop =
      totalDistance > 4 * minSignificantDist &&
      maxDev > 6 * profile.maxStationaryRadius &&
      draft.path.length > MIN_PATH_POINTS * 2;

    const insignificant =
      !significantDisplacement &&
      !significantLoop &&
      (
        totalDistance < minSignificantDist ||
        (maxDev < maxLoopDev && draft.path.length <= MIN_PATH_POINTS) ||
        startEndDist < maxLoopDev ||
        avgRoadSpeed < profile.minAverageVelocity ||
        efficiency < profile.minEfficiency
      );

    if (!insignificant) {
      // COMMIT: Close predecessor and this motion
      const predStats = this.computeStats(draft.predecessor.recent);

      // Trim settling jitter: remove points that occur after the settlement window started
      const trimmedPath = draft.path.filter(pt => pt.timestamp < settleStart);

      // Build accuracy-aware path and smooth it
      const rawPoints = [
        { point: draft.startAnchor, accuracy: 1, timestamp: draft.start }, // Anchor: high certainty
        ...trimmedPath.map(pt => ({ point: pt.mean, accuracy: pt.accuracy, timestamp: pt.timestamp })),
        { point: settleStats.mean, accuracy: 1, timestamp: settleStart },  // Anchor: high certainty
      ];
      const stablePath = smoothPath(rawPoints);

      this.closed.push({
        type: 'stationary',
        start: draft.predecessor.start,
        end: draft.stationaryCutoff,
        mean: predStats.mean,
        variance: predStats.variance
      });

      this.closed.push({
        type: 'motion',
        start: draft.start,
        end: settleStart,
        startAnchor: draft.startAnchor,
        endAnchor: settleStats.mean,
        path: stablePath,
        distance: totalDistance
      });

      // Start new stationary
      this.draft = {
        type: 'stationary',
        start: settleStart,
        stationaryStartAnchor: settleStats.mean,
        recent: [...draft.recent],
        pending: []
      };
      this.recordDebug(p, 'settled-significant');
    } else {
      // ABSORB: Merge into predecessor
      const predecessor = draft.predecessor;

      // We take the settling window as the new "stable" cluster
      predecessor.recent = [...draft.recent];
      predecessor.pending = [];
      predecessor.stationaryStartAnchor = settleStats.mean; // Update anchor to prevent drag!

      this.draft = predecessor;
      this.recordDebug(p, 'settled-absorbed');
    }
  }

  private checkSettled(draft: MotionDraft, profile: MotionProfileConfig): boolean {
    if (draft.recent.length < profile.motionSettleWindowSize) return false;

    const duration = draft.recent[draft.recent.length - 1]!.timestamp - draft.recent[0]!.timestamp;
    if (duration < profile.minStationaryDuration) return false;

    const stats = this.computeStats(draft.recent);
    const minVariance = Math.pow(profile.maxStationaryRadius / 3, 2); // 1-sigma floor
    const effectiveVariance = Math.max(stats.variance, minVariance);

    for (const p of draft.recent) {
      const m2 = this.computeMahalanobis2(p.mean, stats.mean, effectiveVariance);
      if (m2 > profile.motionSettleMahalanobisThreshold) return false;
    }

    return true;
  }

  private checkCoherence(directions: Vec2[], threshold: number): boolean {
    if (directions.length < 2) return true;
    let sx = 0, sy = 0;
    for (const d of directions) {
      sx += d[0];
      sy += d[1];
    }
    const mag = Math.hypot(sx, sy);
    if (mag === 0) return false;
    const avgX = sx / mag;
    const avgY = sy / mag;
    for (const d of directions) {
      if (d[0] * avgX + d[1] * avgY < threshold) return false;
    }
    return true;
  }

  public computeStats(points: DevicePoint[]): { mean: Vec2; variance: number } {
    if (points.length === 0) return { mean: [0, 0], variance: 1 };

    let sumX = 0, sumY = 0;
    for (const p of points) {
      sumX += p.mean[0];
      sumY += p.mean[1];
    }
    const mean: Vec2 = [sumX / points.length, sumY / points.length];

    let sumDistSq = 0;
    for (const p of points) {
      const dx = p.mean[0] - mean[0];
      const dy = p.mean[1] - mean[1];
      sumDistSq += (dx * dx + dy * dy);
    }

    const variance = sumDistSq / points.length;

    // Variance cap to prevent "mega-anchors" that swallow large jumps
    const MIN_VARIANCE = 2.0;
    const MAX_VARIANCE = 400.0;
    const v = Math.max(MIN_VARIANCE, Math.min(MAX_VARIANCE, variance));

    return { mean, variance: v };
  }

  private computeMahalanobis2(pos: Vec2, mean: Vec2, variance: number): number {
    const dx = pos[0] - mean[0];
    const dy = pos[1] - mean[1];
    return (dx * dx + dy * dy) / variance;
  }

  public computePathLength(path: (Vec2 | DevicePoint)[]): number {
    let dist = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const p1 = 'mean' in a ? a.mean : a;
      const p2 = 'mean' in b ? b.mean : b;
      dist += haversineDistance(fromWebMercator(p1), fromWebMercator(p2));
    }
    return dist;
  }

  private maxDeviation(path: DevicePoint[], anchor: Vec2): number {
    let maxD2 = 0;
    for (const p of path) {
      const dx = p.mean[0] - anchor[0];
      const dy = p.mean[1] - anchor[1];
      const d2 = dx * dx + dy * dy;
      if (d2 > maxD2) maxD2 = d2;
    }
    return Math.sqrt(maxD2);
  }

  private recordDebug(p: DevicePoint, decision: DebugDecision, mean: Vec2 | null = null, variance: number | null = null, m2: number | null = null) {
    this.debugFrames.push({
      timestamp: p.timestamp,
      decision,
      point: p.mean,
      mean,
      variance,
      mahalanobis2: m2,
      pendingCount: this.draft?.type === 'stationary' ? this.draft.pending.length : 0,
      draftType: this.draft?.type ?? 'none'
    });
    // Cap debug frames
    if (this.debugFrames.length > DEBUG_FRAME_CAP) this.debugFrames.shift();
  }

  getCurrentSnapshot(): EngineSnapshot | null {
    if (!this.draft) return null;
    return {
      draft: this.draft,
      closed: this.closed,
      timestamp: this.lastTimestamp,
      activeConfidence: 1.0 // Simple for now
    };
  }

  createSnapshot(): EngineState {
    return {
      draft: JSON.parse(JSON.stringify(this.draft)) as EngineDraft,
      closed: JSON.parse(JSON.stringify(this.closed)) as EngineEvent[],
      debugFrames: [...this.debugFrames],
      seenDebugKeys: new Set(this.seenDebugKeys)
    };
  }

  restoreSnapshot(state: EngineState) {
    this.draft = state.draft;
    this.closed = state.closed;
    this.debugFrames = state.debugFrames;
    this.seenDebugKeys = new Set(state.seenDebugKeys);
    this.lastTimestamp = this.draft?.start ?? null;
  }

  pruneHistory(horizon: Timestamp) {
    this.closed = this.closed.filter(ev => ev.end > horizon);
  }

  refineHistory(profile: MotionProfileConfig) {
    // Safety: ensure chronological order before merging
    this.closed.sort((a, b) => a.start - b.start);

    let i = 0;
    while (i < this.closed.length - 2) {
      const current = this.closed[i]!;
      const next = this.closed[i + 1]!;
      const nextNext = this.closed[i + 2]!;

      if (
        current.type === 'motion' &&
        next.type === 'stationary' &&
        nextNext.type === 'motion' &&
        next.end > next.start && // Basic validity check
        next.end - next.start < profile.maxMergeGapDuration
      ) {
        const merged: MotionEvent = {
          type: 'motion',
          start: current.start,
          end: nextNext.end,
          startAnchor: current.startAnchor,
          endAnchor: nextNext.endAnchor,
          path: [...current.path, ...nextNext.path],
          distance: 0
        };
        merged.distance = this.computePathLength(merged.path);

        this.closed.splice(i, 3, merged);
      } else {
        i++;
      }
    }
  }
}
