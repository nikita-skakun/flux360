import { computeBounds } from "@/util/geo";
import { Engine } from "@/engine/engine";
import { fromWebMercator } from "@/util/webMercator";
import type { DevicePoint, MotionProfileName, EngineEvent, Vec2, Timestamp, EngineSnapshot } from "@/types";

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h}h ${min}m`;
}

export function dedupeKey(p: { device: number; timestamp: Timestamp; geo: Vec2 }) {
  return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
}

export function buildEngineSnapshotsFromByDevice(
  byDevice: Record<number, DevicePoint[]>,
  enginesRef: Map<number, Engine>,
  groupIdsRef: Set<number>,
  groupMotionProfiles: Map<number, MotionProfileName>,
  deviceMotionProfiles: Record<number, MotionProfileName>
): { positionsByDevice: Record<number, DevicePoint[]>; snapshotsByDevice: Map<number, EngineSnapshot[]>; eventsByDevice: Record<number, EngineEvent[]> } {
  try {
    // 1. Process measurements for all devices in this batch
    Object.entries(byDevice).forEach(([deviceKey, arr]) => {
      const deviceId = Number(deviceKey);
      if (!enginesRef.has(deviceId)) {
        enginesRef.set(deviceId, new Engine());
      }
      const engine = enginesRef.get(deviceId)!;
      const profile = groupIdsRef.has(deviceId)
        ? (groupMotionProfiles.get(deviceId) ?? "person")
        : (deviceMotionProfiles[deviceId] ?? "person");
      engine.setMotionProfile(profile);
      engine.processMeasurements(arr);
      engine.refineHistory();
    });

    // 2. Build current state for all engines using reduce
    const result = Array.from(enginesRef.entries()).reduce((acc, [deviceId, engine]) => {
      try {
        const snapshot = engine.getCurrentSnapshot();
        const events = [...engine.closed];

        if (snapshot) {
          acc.snapshotsByDevice.set(deviceId, [snapshot]);
          const draft = snapshot.draft;
          const endTs = (snapshot.timestamp ?? Date.now()) as Timestamp;

          if (draft) {
            const isStationary = draft.type === 'stationary';
            const isMotion = draft.type === 'motion';

            // Determine if we should treat as stationary (either actual stationary or zero-distance motion)
            let treatAsStationary = isStationary;
            let stats = null;

            if (isMotion) {
              const distance = engine.computePathLength(draft.path);
              // If distance is 0 and has multiple points, treat as stationary
              treatAsStationary = distance === 0 && draft.path.length > 1;
            }

            if (treatAsStationary) {
              stats = engine.computeStats(isStationary ? draft.recent : draft.path);
              events.push({
                type: 'stationary',
                start: draft.start,
                end: endTs,
                mean: stats.mean,
                variance: stats.variance,
                isDraft: true,
                bounds: computeBounds([stats.mean])
              });
              acc.positionsByDevice[deviceId] = [{
                mean: stats.mean,
                timestamp: endTs,
                device: deviceId,
                geo: fromWebMercator(stats.mean),
                accuracy: Math.sqrt(stats.variance),
                anchorStartTimestamp: draft.start,
                confidence: snapshot.activeConfidence,
                sourceDeviceId: null
              }];
            } else if (isMotion) {
              const lastPt = draft.path[draft.path.length - 1]!;
              const distance = engine.computePathLength(draft.path);

              events.push({
                type: 'motion',
                start: draft.start,
                end: endTs,
                startAnchor: draft.startAnchor,
                endAnchor: lastPt.mean,
                path: draft.path.map(p => p.mean),
                distance: distance,
                isDraft: true,
                bounds: computeBounds(draft.path.map(p => p.mean))
              });
              acc.positionsByDevice[deviceId] = [{
                mean: lastPt.mean,
                timestamp: endTs,
                device: deviceId,
                geo: fromWebMercator(lastPt.mean),
                accuracy: Math.sqrt(engine.computeStats(draft.path).variance),
                anchorStartTimestamp: draft.start,
                confidence: snapshot.activeConfidence,
                sourceDeviceId: null
              }];
            } else {
              // Unknown draft type - clear to prevent stale state
              acc.positionsByDevice[deviceId] = [];
            }
          } else {
            // No draft - clear to prevent stale state
            acc.positionsByDevice[deviceId] = [];
          }
        } else {
          // No snapshot - clear to prevent stale state
          acc.positionsByDevice[deviceId] = [];
        }
        acc.eventsByDevice[deviceId] = events;
      } catch (innerError) {
        console.error(`Error processing snapshot for device ${deviceId}:`, innerError);
        // Clear state on error to prevent stale snapshots
        acc.positionsByDevice[deviceId] = [];
        acc.eventsByDevice[deviceId] = [];
        acc.snapshotsByDevice.set(deviceId, []);
      }
      return acc;
    }, {
      positionsByDevice: {} as Record<number, DevicePoint[]>,
      snapshotsByDevice: new Map<number, EngineSnapshot[]>(),
      eventsByDevice: {} as Record<number, EngineEvent[]>
    });

    return { positionsByDevice: result.positionsByDevice, snapshotsByDevice: result.snapshotsByDevice, eventsByDevice: result.eventsByDevice };
  } catch (e) {
    console.error("Error building engine snapshots:", e);
    return { positionsByDevice: {}, snapshotsByDevice: new Map(), eventsByDevice: {} };
  }
}