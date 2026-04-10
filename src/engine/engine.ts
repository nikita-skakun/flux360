import { asWebMercatorCoord } from "@/types";
import { filterMotionOutliers } from "@/util/motionOutliers";
import { fromWebMercator, WORLD_R } from "@/util/webMercator";
import { haversineDistance, computeBounds, getRadiusFromVariance } from "@/util/geo";
import { MOTION_PROFILES, ENGINE_WINDOW_SIZE, PENDING_THRESHOLD, MIN_PATH_POINTS, HARD_BREAKOUT_DISTANCE, SETTLING_WINDOW_CAP } from "./motionDetector";
import { vlog } from "@/util/logger";
import type { DevicePoint, MotionProfileName, Vec2, EngineEvent, EngineDraft, StationaryDraft, MotionDraft, MotionEvent, EngineState, WebMercatorCoord } from "@/types";
import type { MotionProfileConfig } from "./motionDetector";

const MIN_CLUSTER_VARIANCE = 2.0;
const MAX_CLUSTER_VARIANCE = 400.0;

export class Engine {
  draft: EngineDraft | null = null;
  closed: EngineEvent[] = [];
  lastTimestamp: number | null = null;
  public motionProfile: MotionProfileName = "person";

  setMotionProfile(profile: MotionProfileName) {
    this.motionProfile = profile;
  }

  private getProfile(): MotionProfileConfig {
    return MOTION_PROFILES[this.motionProfile];
  }

  private distanceBetweenWebMercator(a: Vec2, b: Vec2): number {
    return haversineDistance(fromWebMercator(a), fromWebMercator(b));
  }

  processMeasurements(points: DevicePoint[]) {
    for (const p of points) {
      this.step(p);
      this.lastTimestamp = p.timestamp;
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
      return;
    }

    if (this.draft.type === 'stationary') this.handleStationary(this.draft, p, profile);
    else this.handleMotion(this.draft, p, profile);
  }

  private handleStationary(draft: StationaryDraft, p: DevicePoint, profile: MotionProfileConfig) {
    const stats = this.computeStats(draft.recent);
    const m2 = this.computeMahalanobis2(p.mean, stats.mean, stats.variance, p.accuracy);
    const stationaryStartGeo = fromWebMercator(draft.stationaryStartAnchor);

    // Hard breakout check: if we are too far from the ORIGINAL anchor, force motion
    const distFromStart = this.distanceBetweenWebMercator(p.mean, draft.stationaryStartAnchor);
    const isFar = (distFromStart - p.accuracy) > HARD_BREAKOUT_DISTANCE;

    if (m2 < profile.stationaryMahalanobisThreshold && !isFar) {
      // It's stationary
      draft.recent.push(p);
      if (draft.recent.length > ENGINE_WINDOW_SIZE) draft.recent.shift();
      draft.pending = []; // Reset hysteresis
      return;
    }

    // Potential motion
    draft.pending.push(p);
    if (draft.pending.length < PENDING_THRESHOLD) return;

    // Alignment Gate: Transition only if points are coherent
    const directions: Vec2[] = [];
    let allPendingFar = true;
    for (const pt of draft.pending) {
      const dx = pt.mean[0] - stats.mean[0];
      const dy = pt.mean[1] - stats.mean[1];
      const mag = Math.hypot(dx, dy);
      directions.push(mag > 0 ? [dx / mag, dy / mag] : [0, 0]);
      if ((haversineDistance(fromWebMercator(pt.mean), stationaryStartGeo) - pt.accuracy) <= HARD_BREAKOUT_DISTANCE)
        allPendingFar = false;
    }

    // In addition to coherence, the raw speed of the draft must be plausible.
    const firstPending = draft.pending[0];
    let isFastEnough = true;
    if (firstPending && draft.pending.length > 1) {
      const lastPending = draft.pending[draft.pending.length - 1]!;
      const dist = this.distanceBetweenWebMercator(firstPending.mean, lastPending.mean);

      // If they've moved less than HARD_BREAKOUT, we demand a minimum speed to prevent slow drift
      if (dist < HARD_BREAKOUT_DISTANCE) {
        const timeSecs = (lastPending.timestamp - firstPending.timestamp) / 1000;
        if (timeSecs > 0)
          isFastEnough = (dist / timeSecs) > (profile.minAverageVelocity * 0.25);
      }
    }

    if (firstPending && (allPendingFar || (this.checkCoherence(directions, profile.coherenceCosineThreshold) && isFastEnough))) {
      // Transition to Motion
      const startTimestamp = firstPending.timestamp;
      this.draft = {
        type: 'motion',
        start: startTimestamp,
        stationaryCutoff: startTimestamp,
        predecessor: draft,
        startAnchor: stats.mean,
        path: [...draft.pending],
        outliers: [],
        recent: [draft.pending[draft.pending.length - 1]!]
      };
      return;
    }

    // Mushy noise. Merge oldest pending into recent to prevent buffer bloat
    const first = draft.pending.shift();
    if (!first) return;

    draft.recent.push(first);
    if (draft.recent.length > ENGINE_WINDOW_SIZE) draft.recent.shift();
    if (draft.recent.length < 10) return;

    const newStats = this.computeStats(draft.recent);
    const distToAnchor = this.distanceBetweenWebMercator(newStats.mean, draft.stationaryStartAnchor);
    if (distToAnchor > profile.maxStationaryRadius) draft.stationaryStartAnchor = newStats.mean; // Update anchor to prevent drag
  }

  private handleMotion(draft: MotionDraft, p: DevicePoint, profile: MotionProfileConfig) {
    draft.path.push(p);
    draft.recent.push(p);

    const { cleanPath, newOutliers } = filterMotionOutliers(
      draft.path, 
      draft.outliers, 
      (p) => p.mean
    );
    draft.path = cleanPath;
    draft.outliers = newOutliers;

    // Cap settling window by count to handle sparse GPS data.
    // checkSettled's own duration check handles the time constraint.
    if (draft.recent.length > SETTLING_WINDOW_CAP)
      draft.recent.splice(0, draft.recent.length - SETTLING_WINDOW_CAP);

    const isSettled = this.checkSettled(draft, profile);
    if (!isSettled) return;

    // Settled! Decide if significant or noise
    const settleStart = draft.recent[0]!.timestamp;
    const settleStats = this.computeStats(draft.recent);
    const totalDistance = this.computePathLength(draft.path.map(p => p.mean));
    const startEndDist = this.distanceBetweenWebMercator(draft.startAnchor, settleStats.mean);
    const maxDev = this.maxDeviation(draft.path, draft.startAnchor);

    const settleDurationSeconds = (draft.recent[draft.recent.length - 1]!.timestamp - draft.start) / 1000;
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
      const startAnchorAccuracy = getRadiusFromVariance(predStats.variance);
      const endAnchorAccuracy = getRadiusFromVariance(settleStats.variance);

      // Trim settling jitter: remove points that occur after the settlement window started
      const trimmedPath = draft.path.filter(pt => pt.timestamp < settleStart);

      // Build raw, accuracy-aware path (client will smooth)
      const deviceId = draft.path[0]?.device ?? draft.predecessor.recent[0]?.device;
      if (deviceId === undefined) { throw new Error('Engine: unable to determine deviceId for motion path'); }

      // The start anchor represents the stable center of the PREVIOUS stationary period.
      // We use the timestamp of the last point in the stationary window as the time we "left" that anchor.
      const predecessorPoints = draft.predecessor.recent;
      const lastStableTimestamp = (predecessorPoints.length > 0)
        ? predecessorPoints[predecessorPoints.length - 1]!.timestamp
        : draft.start;

      const path = [
        { device: deviceId, geo: draft.startAnchor, accuracy: startAnchorAccuracy, timestamp: lastStableTimestamp },
        ...trimmedPath.map(pt => ({ device: pt.device, geo: pt.mean, accuracy: pt.accuracy, timestamp: pt.timestamp })),
        { device: deviceId, geo: settleStats.mean, accuracy: endAnchorAccuracy, timestamp: settleStart },
      ];

      const outliers = draft.outliers.map(pt => ({ device: pt.device, geo: pt.mean, accuracy: pt.accuracy, timestamp: pt.timestamp }));

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
        path,
        outliers,
        distance: totalDistance,
        isDraft: false,
        bounds: computeBounds(path.map(p => p.geo))
      });
      vlog(`[Engine] Closed motion event for device. History size: ${this.closed.length}`);

      // Start new stationary
      this.draft = {
        type: 'stationary',
        start: settleStart,
        stationaryStartAnchor: settleStats.mean,
        recent: [...draft.recent],
        pending: []
      };
    } else {
      // ABSORB: Merge into predecessor
      const predecessor = draft.predecessor;

      // We take the settling window as the new "stable" cluster
      predecessor.recent = [...draft.recent];
      predecessor.pending = [];
      predecessor.stationaryStartAnchor = settleStats.mean; // Update anchor to prevent drag

      this.draft = predecessor;
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

    for (const p of draft.recent)
      if (this.computeMahalanobis2(p.mean, stats.mean, effectiveVariance, p.accuracy) > profile.motionSettleMahalanobisThreshold)
        return false;
    return true;
  }

  private checkCoherence(directions: Vec2[], threshold: number): boolean {
    if (directions.length < 2) return true;

    const sum = directions.reduce((acc, d) => [acc[0] + d[0], acc[1] + d[1]], [0, 0]);
    const mag = Math.hypot(sum[0], sum[1]);
    if (mag === 0) return false;

    const avg: Vec2 = [sum[0] / mag, sum[1] / mag];
    return directions.every(d => (d[0] * avg[0] + d[1] * avg[1]) >= threshold);
  }

  public computeStats(points: DevicePoint[]): { mean: WebMercatorCoord; variance: number } {
    if (points.length === 0) return { mean: asWebMercatorCoord([0, 0]), variance: 1 };

    let sumX = 0, sumY = 0;
    for (const point of points) {
      sumX += point.mean[0];
      sumY += point.mean[1];
    }

    const mean: WebMercatorCoord = asWebMercatorCoord([sumX / points.length, sumY / points.length]);

    let sumDistSq = 0;
    for (const point of points) {
      const dx = point.mean[0] - mean[0];
      const dy = point.mean[1] - mean[1];
      sumDistSq += dx * dx + dy * dy;
    }

    // Variance cap to prevent "mega-anchors" that swallow large jumps
    return { mean, variance: Math.max(MIN_CLUSTER_VARIANCE, Math.min(MAX_CLUSTER_VARIANCE, sumDistSq / points.length)) };
  }

  private computeMahalanobis2(pos: Vec2, mean: Vec2, clusterVariance: number, pointAccuracy: number): number {
    const dx = pos[0] - mean[0];
    const dy = pos[1] - mean[1];
    const latRad = 2 * Math.atan(Math.exp(pos[1] / WORLD_R)) - Math.PI / 2;
    return (dx * dx + dy * dy) / (clusterVariance + (pointAccuracy / Math.cos(latRad)) ** 2);
  }

  public computePathLength(path: Vec2[]): number {
    let total = 0;
    for (let i = 1; i < path.length; i++)
      total += this.distanceBetweenWebMercator(path[i - 1]!, path[i]!);
    return total;
  }

  private maxDeviation(path: DevicePoint[], anchor: Vec2): number {
    let maxD2 = 0;
    for (const point of path) {
      const dx = point.mean[0] - anchor[0];
      const dy = point.mean[1] - anchor[1];
      const distSq = dx * dx + dy * dy;
      if (distSq > maxD2) maxD2 = distSq;
    }
    return Math.sqrt(maxD2);
  }

  getState(): EngineState | null {
    if (!this.draft) return null;
    return {
      draft: this.draft,
      closed: this.closed,
      lastTimestamp: this.lastTimestamp,
    };
  }

  createSnapshot(): EngineState {
    vlog(`[Engine] Creating snapshot. History size: ${this.closed.length}`);
    return JSON.parse(JSON.stringify({
      draft: this.draft,
      closed: this.closed,
      lastTimestamp: this.lastTimestamp,
    })) as EngineState;
  }

  restoreSnapshot(state: EngineState) {
    this.draft = state.draft;
    this.closed = (state.closed ?? []).map(ev => ({ ...ev, isDraft: ev.isDraft ?? false }));
    this.lastTimestamp = state.lastTimestamp ?? this.draft?.start ?? null;
    vlog(`[Engine] Restored snapshot. History size: ${this.closed.length}`);
  }

  pruneHistory(horizon: number) {
    this.closed = this.closed.filter(ev => ev.end > horizon);
  }

  refineHistory() {
    const profile = this.getProfile();
    this.closed.sort((a, b) => a.start - b.start);

    let i = 0;
    while (i < this.closed.length - 2) {
      const current = this.closed[i];
      const next = this.closed[i + 1];
      const nextNext = this.closed[i + 2];

      if (current?.type === 'motion' && next?.type === 'stationary' && nextNext?.type === 'motion') {
        const gapDuration = next.end - next.start;
        const bridgeDistance = this.distanceBetweenWebMercator(current.endAnchor, nextNext.startAnchor);

        // If the stationary variance is saturated and both motions bridge the same anchor,
        // treat this stop as low-confidence noise and allow a wider merge window.
        const uncertainStationaryGap =
          next.variance >= (MAX_CLUSTER_VARIANCE * 0.98) &&
          bridgeDistance <= profile.maxStationaryRadius &&
          gapDuration < (profile.maxMergeGapDuration * 3);

        if (!(gapDuration < profile.maxMergeGapDuration || uncertainStationaryGap)) {
          i++;
          continue;
        }

        const mergedPath = [...current.path, ...nextNext.path];
        const mergedOutliers = [...current.outliers, ...nextNext.outliers];
        const merged: MotionEvent = {
          type: 'motion',
          start: current.start,
          end: Math.max(current.start, nextNext.end),
          startAnchor: current.startAnchor,
          endAnchor: nextNext.endAnchor,
          path: mergedPath,
          outliers: mergedOutliers,
          distance: this.computePathLength(mergedPath.map(p => p.geo)),
          isDraft: false,
          bounds: computeBounds(mergedPath.map(p => p.geo))
        };
        this.closed.splice(i, 3, merged);
      } else {
        i++;
      }
    }
  }
}
