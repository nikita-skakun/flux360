import { Engine, type EngineSnapshot } from "@/engine/engine";
import type { DevicePoint, MotionProfileName, EngineEvent, Vec2, Timestamp } from "@/types";
import { fromWebMercator } from "@/util/webMercator";

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
    for (const [deviceKey, arr] of Object.entries(byDevice)) {
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
    }

    const currentSnapshots: Record<number, DevicePoint[]> = {};
    const snapshotsByDevice = new Map<number, EngineSnapshot[]>();
    const eventsByDevice: Record<number, EngineEvent[]> = {};

    for (const deviceId of enginesRef.keys()) {
      try {
        const engine = enginesRef.get(deviceId);
        if (!engine) continue;
        const snapshot = engine.getCurrentSnapshot();

        if (snapshot) {
          snapshotsByDevice.set(deviceId, [snapshot]);
          
          const events = [...engine.closed];
          const draft = snapshot.draft;
          if (draft) {
            if (draft.type === 'stationary') {
              const stats = engine.computeStats(draft.recent);
              events.push({
                type: 'stationary',
                start: draft.start,
                end: (snapshot.timestamp ?? Date.now()) as Timestamp,
                mean: stats.mean,
                variance: stats.variance,
                isDraft: true
              });

              // Also use these stats for currentSnapshots
              currentSnapshots[deviceId] = [{
                mean: stats.mean,
                timestamp: snapshot.timestamp ?? Date.now() as Timestamp,
                device: deviceId,
                geo: fromWebMercator(stats.mean),
                accuracy: 5, // Default placeholder for UI
                anchorStartTimestamp: draft.start,
                confidence: snapshot.activeConfidence,
                sourceDeviceId: null
              }];
            } else {
              // Motion
              events.push({
                type: 'motion',
                start: draft.start,
                end: (snapshot.timestamp ?? Date.now()) as Timestamp,
                startAnchor: draft.startAnchor,
                endAnchor: draft.path[draft.path.length - 1]!.mean, // last known point
                path: draft.path.map(p => p.mean),
                distance: engine.computePathLength(draft.path),
                isDraft: true
              });

              // Motion: use last path point for currentSnapshots
              const lastPt = draft.path[draft.path.length - 1]!;
              const lastMean = lastPt.mean;
              currentSnapshots[deviceId] = [{
                mean: lastMean,
                timestamp: snapshot.timestamp ?? Date.now() as Timestamp,
                device: deviceId,
                geo: fromWebMercator(lastMean),
                accuracy: 5,
                anchorStartTimestamp: draft.start,
                confidence: 1.0,
                sourceDeviceId: null
              }];
            }
          }
          eventsByDevice[deviceId] = events;
        } else {
          currentSnapshots[deviceId] = [];
        }
      } catch (innerError) {
        console.error(`Error processing snapshot for device ${deviceId}:`, innerError);
      }
    }
    return { positionsByDevice: currentSnapshots, snapshotsByDevice, eventsByDevice };
  } catch (e) {
    console.error("Error building engine snapshots:", e);
    return { positionsByDevice: {}, snapshotsByDevice: new Map(), eventsByDevice: {} };
  }
}