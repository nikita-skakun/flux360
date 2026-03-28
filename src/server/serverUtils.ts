import { computeBounds } from "@/util/geo";
import { Engine } from "@/engine/engine";
import { fromWebMercator } from "@/util/webMercator";
import { numericEntries } from "@/util/record";
import { RawTraccarPositionSchema } from "@/types";
import type { DevicePoint, MotionProfileName, EngineEvent, EngineState, NormalizedPosition } from "@/types";

export function normalizePosition(raw: unknown): NormalizedPosition | null {
  try {
    const parsed = RawTraccarPositionSchema.parse(raw);
    const { latitude, longitude, fixTime, deviceId, accuracy } = parsed;

    const ts = Date.parse(fixTime);
    if (Number.isNaN(ts)) return null;

    return {
      device: deviceId,
      timestamp: ts,
      geo: [longitude, latitude],
      accuracy: accuracy ?? 100,
    };
  } catch {
    return null;
  }
}

export function buildEngineSnapshotsFromByDevice(
  byDevice: Record<number, DevicePoint[]>,
  engines: Record<number, Engine>,
  motionProfiles: Record<number, MotionProfileName>
): { positionsByDevice: Record<number, DevicePoint[]>; engineStatesByDevice: Record<number, EngineState[]>; eventsByDevice: Record<number, EngineEvent[]> } {
  try {
    // 1. Process measurements for all devices in this batch
    for (const [deviceId, arr] of numericEntries(byDevice)) {
      let engine = engines[deviceId];
      if (!engine) {
        engine = new Engine();
        engines[deviceId] = engine;
      }
      const profile = motionProfiles[deviceId] ?? "person";
      engine.setMotionProfile(profile);
      engine.processMeasurements(arr);
      engine.refineHistory();
    }

    // 2. Build current state for all engines
    const positionsByDevice: Record<number, DevicePoint[]> = {};
    const engineStatesByDevice: Record<number, EngineState[]> = {};
    const eventsByDevice: Record<number, EngineEvent[]> = {};

    for (const [deviceId, engine] of numericEntries(engines)) {
      try {
        const snapshot = engine.getState();
        const events = [...engine.closed];

        if (!snapshot?.draft) {
          positionsByDevice[deviceId] = [];
          eventsByDevice[deviceId] = events;
          continue;
        }

        engineStatesByDevice[deviceId] = [snapshot];
        const draft = snapshot.draft;
        const endTs = snapshot.lastTimestamp ?? Date.now();

        const isStationary = draft.type === 'stationary';
        const isMotion = draft.type === 'motion';
        const distance = isMotion ? engine.computePathLength(draft.path.map(p => p.mean)) : 0;
        const treatAsStationary =
                    isStationary || (isMotion && distance === 0 && draft.path.length > 1);

        if (treatAsStationary) {
          const stats = engine.computeStats(isStationary ? draft.recent : draft.path);
          events.push({
            type: 'stationary',
            start: draft.start,
            end: endTs,
            mean: stats.mean,
            variance: stats.variance,
            isDraft: true,
          });
          positionsByDevice[deviceId] = [{
            mean: stats.mean,
            timestamp: endTs,
            device: deviceId,
            geo: fromWebMercator(stats.mean),
            accuracy: Math.sqrt(stats.variance),
            anchorStartTimestamp: draft.start,
            confidence: 1.0,
            sourceDeviceId: null
          }];
        } else if (isMotion) {
          const lastPt = draft.path[draft.path.length - 1]!;
          const stats = engine.computeStats(draft.path);
          const motionPath = draft.path.map(p => ({ device: p.device, geo: p.mean, accuracy: p.accuracy, timestamp: p.timestamp }));
          const motionOutliers = draft.outliers.map(p => ({ device: p.device, geo: p.mean, accuracy: p.accuracy, timestamp: p.timestamp }));
          events.push({
            type: 'motion',
            start: draft.start,
            end: endTs,
            startAnchor: draft.startAnchor,
            endAnchor: lastPt.mean,
            path: motionPath,
            outliers: motionOutliers,
            distance,
            isDraft: true,
            bounds: computeBounds(motionPath.map(p => p.geo))
          });
          positionsByDevice[deviceId] = [{
            mean: lastPt.mean,
            timestamp: endTs,
            device: deviceId,
            geo: fromWebMercator(lastPt.mean),
            accuracy: Math.sqrt(stats.variance),
            anchorStartTimestamp: draft.start,
            confidence: 1.0,
            sourceDeviceId: null
          }];
        } else {
          // Unexpected draft type, clear to avoid stale state
          positionsByDevice[deviceId] = [];
        }

        eventsByDevice[deviceId] = events;
      } catch (innerError) {
        console.error(`Error processing snapshot for device ${deviceId}:`, innerError);
        positionsByDevice[deviceId] = [];
        eventsByDevice[deviceId] = [];
        engineStatesByDevice[deviceId] = [];
      }
    }

    return { positionsByDevice, engineStatesByDevice, eventsByDevice };
  } catch (e) {
    console.error("Error building engine snapshots:", e);
    return { positionsByDevice: {}, engineStatesByDevice: {}, eventsByDevice: {} };
  }
}
