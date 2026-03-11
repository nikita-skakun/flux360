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

    const positionsByDevice: Record<number, DevicePoint[]> = {};
    const snapshotsByDevice = new Map<number, EngineSnapshot[]>();
    const eventsByDevice: Record<number, EngineEvent[]> = {};

    // 2. Build current state for all engines
    Array.from(enginesRef.entries()).forEach(([deviceId, engine]) => {
      try {
        const snapshot = engine.getCurrentSnapshot();
        const events = [...engine.closed];

        if (snapshot) {
          snapshotsByDevice.set(deviceId, [snapshot]);
          const draft = snapshot.draft;
          if (draft) {
            const isStationary = draft.type === 'stationary';
            const stats = isStationary ? engine.computeStats(draft.recent) : null;
            const endTs = (snapshot.timestamp ?? Date.now()) as Timestamp;

            if (isStationary && stats) {
              events.push({
                type: 'stationary',
                start: draft.start,
                end: endTs,
                mean: stats.mean,
                variance: stats.variance,
                isDraft: true,
                bounds: computeBounds([stats.mean])
              });
              positionsByDevice[deviceId] = [{
                mean: stats.mean,
                timestamp: endTs,
                device: deviceId,
                geo: fromWebMercator(stats.mean),
                accuracy: 5,
                anchorStartTimestamp: draft.start,
                confidence: snapshot.activeConfidence,
                sourceDeviceId: null
              }];
            } else if (draft.type === 'motion') {
              const lastPt = draft.path[draft.path.length - 1]!;
              events.push({
                type: 'motion',
                start: draft.start,
                end: endTs,
                startAnchor: draft.startAnchor,
                endAnchor: lastPt.mean,
                path: draft.path.map(p => p.mean),
                distance: engine.computePathLength(draft.path),
                isDraft: true,
                bounds: computeBounds(draft.path.map(p => p.mean))
              });
              positionsByDevice[deviceId] = [{
                mean: lastPt.mean,
                timestamp: endTs,
                device: deviceId,
                geo: fromWebMercator(lastPt.mean),
                accuracy: 5,
                anchorStartTimestamp: draft.start,
                confidence: 1.0,
                sourceDeviceId: null
              }];
            }
          }
        } else {
          positionsByDevice[deviceId] = [];
        }
        eventsByDevice[deviceId] = events;
      } catch (innerError) {
        console.error(`Error processing snapshot for device ${deviceId}:`, innerError);
      }
    });

    return { positionsByDevice, snapshotsByDevice, eventsByDevice };
  } catch (e) {
    console.error("Error building engine snapshots:", e);
    return { positionsByDevice: {}, snapshotsByDevice: new Map(), eventsByDevice: {} };
  }
}