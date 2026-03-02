import { Engine, type EngineSnapshot } from "@/engine/engine";
import type { DevicePoint, NormalizedPosition, MotionProfileName, MotionSegment, Vec2, Timestamp } from "@/types";
import { fromWebMercator, toWebMercator } from "@/util/webMercator";

export function dedupeKey(p: { device: number; timestamp: Timestamp; geo: Vec2 }) {
  return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
}

export function buildEngineSnapshotsFromByDevice(
  byDevice: Record<number, DevicePoint[]>,
  enginesRef: Map<number, Engine>,
  groupIdsRef: Set<number>,
  groupMotionProfiles: Map<number, MotionProfileName>,
  deviceMotionProfiles: Record<number, MotionProfileName>,
  allPosByDevice: Map<number, NormalizedPosition[]>
): { positionsByDevice: Record<number, DevicePoint[]>; snapshotsByDevice: Map<number, EngineSnapshot[]>; motionSegments: Record<number, MotionSegment[]> } {
  try {
    const measurementsByDevice: Record<number, DevicePoint[]> = {};

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
      // Ensure measurements are sorted by timestamp
      const sortedArr = [...arr].sort((a, b) => a.timestamp - b.timestamp);
      measurementsByDevice[deviceId] = sortedArr;
      engine.processMeasurements(sortedArr);
    }

    const currentSnapshots: Record<number, DevicePoint[]> = {};
    const snapshotsByDevice = new Map<number, EngineSnapshot[]>();
    const motionSegments: Record<number, MotionSegment[]> = {};
    for (const deviceId of enginesRef.keys()) {
      try {
        const engine = enginesRef.get(deviceId);
        if (!engine) continue;
        const snapshot = engine.getCurrentSnapshot();
        if (snapshot) {
          snapshotsByDevice.set(Number(deviceId), [snapshot]);
          motionSegments[deviceId] = engine.motionSegments;

          const dId = Number(deviceId);
          const measurements: DevicePoint[] = measurementsByDevice[dId] ?? [];
          const timestamp = measurements.at(-1)?.timestamp ?? engine.lastTimestamp ?? Date.now() as Timestamp;

          if (engine.currentMotionSegment) {
            const latestRaw = allPosByDevice.get(dId)?.at(-1);
            if (latestRaw) {
              const point: DevicePoint = {
                mean: toWebMercator(latestRaw.geo),
                timestamp: latestRaw.timestamp,
                device: dId,
                geo: latestRaw.geo,
                accuracy: latestRaw.accuracy,
                anchorStartTimestamp: snapshot.activeAnchor.startTimestamp,
                confidence: 1,
                sourceDeviceId: groupIdsRef.has(dId) ? latestRaw.device : undefined
              };
              currentSnapshots[dId] = [point];
              continue;
            }
          }

          const point: DevicePoint = {
            mean: snapshot.activeAnchor.mean,
            timestamp,
            device: dId,
            geo: fromWebMercator(snapshot.activeAnchor.mean),
            accuracy: Math.max(1, Math.round(Math.sqrt(Math.max(1e-6, snapshot.activeAnchor.variance)))),
            anchorStartTimestamp: snapshot.activeAnchor.startTimestamp,
            confidence: snapshot.activeConfidence,
            sourceDeviceId: undefined
          };
          currentSnapshots[dId] = [point];
        } else {
          currentSnapshots[Number(deviceId)] = [];
        }
      } catch (innerError) {
        console.error(`Error processing snapshot for device ${deviceId}:`, innerError);
        // Continue to next device, don't crash everything
      }
    }
    return { positionsByDevice: currentSnapshots, snapshotsByDevice, motionSegments };
  } catch (e) {
    console.error("Error building engine snapshots:", e);
    return { positionsByDevice: {}, snapshotsByDevice: new Map(), motionSegments: {} };
  }
}