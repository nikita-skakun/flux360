import { Engine, type EngineSnapshot } from "@/engine/engine";
import type { DevicePoint, NormalizedPosition, MotionProfileName, MotionSegment, Vec2, Timestamp } from "@/types";
import { fromWebMercator } from "@/util/webMercator";

export function dedupeKey(p: { device: number; timestamp: Timestamp; lat: number; lon: number }) {
  return `${p.device}:${p.timestamp}:${p.lat}:${p.lon}`;
}

export function measurementVarianceFromAccuracy(accuracyMeters: number) {
  return accuracyMeters * accuracyMeters;
}

export function createDevicePoint(
  mean: Vec2,
  variance: number,
  timestamp: Timestamp,
  deviceId: number,
  geo: Vec2,
  anchorAgeMs: number,
  confidence: number
): DevicePoint {
  const accuracyVal = Math.max(1, Math.round(Math.sqrt(Math.max(1e-6, variance))));
  return { mean, variance, timestamp, device: deviceId, lat: geo[1], lon: geo[0], accuracy: accuracyVal, anchorAgeMs, confidence, sourceDeviceId: undefined };
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
        snapshotsByDevice.set(Number(deviceId), [snapshot]);
        motionSegments[deviceId] = engine.motionSegments;
        if (snapshot.activeAnchor) {
          // Use the latest timestamp from the measurements we just processed, not engine.lastTimestamp
          const dId = Number(deviceId);
          const measurements: DevicePoint[] = measurementsByDevice[dId] ?? [];
          const timestamp = measurements.at(-1)?.timestamp ?? engine.lastTimestamp ?? Date.now();
          const anchorStartTs = (typeof snapshot.activeAnchor.startTimestamp === 'number' && Number.isFinite(snapshot.activeAnchor.startTimestamp)) ? snapshot.activeAnchor.startTimestamp : timestamp;
          const anchorAgeMs = Math.max(0, Date.now() - anchorStartTs);

          if (engine.motionActive) {
            const latestRaw = allPosByDevice.get(dId)?.at(-1);
            if (latestRaw) {
              const point: DevicePoint = { mean: [0, 0], variance: 0, timestamp: latestRaw.timestamp, device: dId, lat: latestRaw.lat, lon: latestRaw.lon, accuracy: latestRaw.accuracy, anchorAgeMs: 0, confidence: 1, sourceDeviceId: undefined };
              currentSnapshots[dId] = [point];
              continue;
            }
          }

          // Convert anchor mean to lat/lon from Web Mercator
          const point = createDevicePoint(snapshot.activeAnchor.mean, snapshot.activeAnchor.variance, timestamp, dId, fromWebMercator(snapshot.activeAnchor.mean), anchorAgeMs, snapshot.activeConfidence);
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