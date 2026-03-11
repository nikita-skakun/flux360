import { haversineDistance } from "@/util/geo";
import { MOTION_PROFILES, ENGINE_WINDOW_SIZE, PENDING_THRESHOLD, MIN_PATH_POINTS, HARD_BREAKOUT_DISTANCE, SETTLING_WINDOW_CAP, DEBUG_FRAME_CAP, type MotionProfileConfig } from "./motionDetector";
import { fromWebMercator } from "@/util/webMercator";
import { smoothPath } from "@/util/pathSmoothing";
import type { DevicePoint, MotionProfileName, Timestamp, Vec2, EngineEvent, EngineDraft, StationaryDraft, MotionDraft, MotionEvent, EngineSnapshot, EngineState, DebugDecision, DebugFrame } from "@/types";

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

        const firstPending = draft.pending[0];
        if (firstPending && (isCoherent || anyPendingFar)) {
          // Transition to Motion
          const startTimestamp = firstPending.timestamp;
          this.draft = {
            type: 'motion',
            start: startTimestamp,
            stationaryCutoff: startTimestamp,
            predecessor: draft,
            startAnchor: stats.mean,
            path: [...draft.pending],
            recent: [draft.pending[draft.pending.length - 1] ?? firstPending]
          };
        } else {
          // Mushy noise. Merge oldest pending into recent to prevent buffer bloat
          const first = draft.pending.shift();
          if (first) {
            draft.recent.push(first);
            if (draft.recent.length > ENGINE_WINDOW_SIZE) draft.recent.shift();
            this.recordDebug(p, 'stationary'); // Re-classify as stationary mush
          }
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
    const firstRecent = draft.recent[0];
    if (!firstRecent) {
      this.recordDebug(p, 'motion');
      return;
    }
    const settleStart = firstRecent.timestamp;
    const settleStats = this.computeStats(draft.recent);
    const totalDistance = this.computePathLength(draft.path);
    const startEndDist = haversineDistance(fromWebMercator(draft.startAnchor), fromWebMercator(settleStats.mean));
    const maxDev = this.maxDeviation(draft.path, draft.startAnchor);

    const lastRecent = draft.recent[draft.recent.length - 1];
    const settleEnd = lastRecent ? lastRecent.timestamp : p.timestamp;
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
        end: Math.max(draft.predecessor.start, draft.stationaryCutoff),
        mean: predStats.mean,
        variance: predStats.variance,
        isDraft: false
      });

      this.closed.push({
        type: 'motion',
        start: draft.start,
        end: Math.max(draft.start, settleStart),
        startAnchor: draft.startAnchor,
        endAnchor: settleStats.mean,
        path: stablePath,
        distance: totalDistance,
        isDraft: false
      });
      console.log(`[Engine] Closed motion event for device. History size: ${this.closed.length}`);

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

    const first = draft.recent[0];
    const last = draft.recent[draft.recent.length - 1];
    if (!first || !last || (last.timestamp - first.timestamp) < profile.minStationaryDuration) return false;

    const stats = this.computeStats(draft.recent);
    const minVariance = Math.pow(profile.maxStationaryRadius / 3, 2); // 1-sigma floor
    const effectiveVariance = Math.max(stats.variance, minVariance);

    return draft.recent.every(p => this.computeMahalanobis2(p.mean, stats.mean, effectiveVariance) <= profile.motionSettleMahalanobisThreshold);
  }

  private checkCoherence(directions: Vec2[], threshold: number): boolean {
    if (directions.length < 2) return true;

    const sum = directions.reduce((acc, d) => [acc[0] + d[0], acc[1] + d[1]], [0, 0]);
    const mag = Math.hypot(sum[0], sum[1]);
    if (mag === 0) return false;

    const avg: Vec2 = [sum[0] / mag, sum[1] / mag];
    return directions.every(d => (d[0] * avg[0] + d[1] * avg[1]) >= threshold);
  }

  public computeStats(points: DevicePoint[]): { mean: Vec2; variance: number } {
    if (points.length === 0) return { mean: [0, 0], variance: 1 };

    const sum = points.reduce((acc, p) => [acc[0] + p.mean[0], acc[1] + p.mean[1]] as Vec2, [0, 0] as Vec2);
    const mean: Vec2 = [sum[0] / points.length, sum[1] / points.length];

    const sumDistSq = points.reduce((acc, p) => {
      const dx = p.mean[0] - mean[0];
      const dy = p.mean[1] - mean[1];
      return acc + (dx * dx + dy * dy);
    }, 0);

    const variance = sumDistSq / points.length;

    // Variance cap to prevent "mega-anchors" that swallow large jumps
    const MIN_VARIANCE = 2.0;
    const MAX_VARIANCE = 400.0;
    return { mean, variance: Math.max(MIN_VARIANCE, Math.min(MAX_VARIANCE, variance)) };
  }

  private computeMahalanobis2(pos: Vec2, mean: Vec2, variance: number): number {
    const dx = pos[0] - mean[0];
    const dy = pos[1] - mean[1];
    return (dx * dx + dy * dy) / variance;
  }

  public computePathLength(path: (Vec2 | DevicePoint)[]): number {
    return path.slice(1).reduce((acc, b, i) => {
      const a = path[i]!;
      const p1 = 'mean' in a ? a.mean : a;
      const p2 = 'mean' in b ? b.mean : b;
      return acc + haversineDistance(fromWebMercator(p1), fromWebMercator(p2));
    }, 0);
  }

  private maxDeviation(path: DevicePoint[], anchor: Vec2): number {
    const maxD2 = path.reduce((max, p) => {
      const dx = p.mean[0] - anchor[0];
      const dy = p.mean[1] - anchor[1];
      return Math.max(max, dx * dx + dy * dy);
    }, 0);
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
    console.log(`[Engine] Creating snapshot. History size: ${this.closed.length}`);
    return JSON.parse(JSON.stringify({
      draft: this.draft,
      closed: this.closed,
      lastTimestamp: this.lastTimestamp,
      debugFrames: this.debugFrames,
      seenDebugKeys: [...this.seenDebugKeys]
    })) as EngineState;
  }

  restoreSnapshot(state: EngineState) {
    this.draft = state.draft;
    this.closed = (state.closed ?? []).map(ev => ({ ...ev, isDraft: ev.isDraft ?? false }));
    this.lastTimestamp = state.lastTimestamp ?? this.draft?.start ?? null;
    this.debugFrames = state.debugFrames;
    this.seenDebugKeys = new Set(state.seenDebugKeys ?? []);
    console.log(`[Engine] Restored snapshot. History size: ${this.closed.length}`);
  }

  pruneHistory(horizon: Timestamp) {
    this.closed = this.closed.filter(ev => ev.end > horizon);
  }

  refineHistory(profile: MotionProfileConfig) {
    this.closed.sort((a, b) => a.start - b.start);

    let i = 0;
    while (i < this.closed.length - 2) {
      const current = this.closed[i];
      const next = this.closed[i + 1];
      const nextNext = this.closed[i + 2];

      if (
        current?.type === 'motion' &&
        next?.type === 'stationary' &&
        nextNext?.type === 'motion' &&
        (next.end - next.start) < profile.maxMergeGapDuration
      ) {
        const merged: MotionEvent = {
          type: 'motion',
          start: current.start,
          end: Math.max(current.start, nextNext.end),
          startAnchor: current.startAnchor,
          endAnchor: nextNext.endAnchor,
          path: [...current.path, ...nextNext.path],
          distance: 0,
          isDraft: false
        };
        merged.distance = this.computePathLength(merged.path);
        this.closed.splice(i, 3, merged);
      } else {
        i++;
      }
    }
  }
}
