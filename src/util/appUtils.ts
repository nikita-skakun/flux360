import { metersToDegrees } from "./geo";
import type { DevicePoint } from "@/ui/types";
import { Engine } from "@/engine/engine";
import type { MotionProfileName } from "@/engine/motionDetector";

export function dedupeKey(p: { device: number; timestamp: number; lat: number; lon: number }) {
  return `${p.device}:${p.timestamp}:${p.lat}:${p.lon}`;
}

export function measurementCovFromAccuracy(accuracyMeters: number) {
  const v = accuracyMeters * accuracyMeters;
  return [v, 0, v] as [number, number, number];
}

export function createDevicePoint(mean: [number, number], cov: [number, number, number], timestamp: number, deviceId: number, refLat: number | null, refLon: number | null, anchorAgeMs: number, confidence: number): DevicePoint {
  const diagMax = Math.max(cov[0], cov[2]);
  const accuracyVal = Math.max(1, Math.round(Math.sqrt(Math.max(1e-6, diagMax))));
  const { lat: compLat, lon: compLon } = metersToDegrees(mean[0], mean[1], refLat ?? 0, refLon ?? 0);
  return { mean, cov, timestamp, device: deviceId, lat: compLat, lon: compLon, accuracy: accuracyVal, anchorAgeMs, confidence };
}

export function buildEngineSnapshotsFromByDevice(
  byDevice: Record<string, DevicePoint[]>,
  enginesRef: React.RefObject<Map<number, Engine>>,
  groupIdsRef: React.RefObject<Set<number>>,
  groupMotionProfiles: Map<number, MotionProfileName>,
  deviceMotionProfiles: Record<number, MotionProfileName>,
  refLat: number | null,
  refLon: number | null
): Record<number, DevicePoint[]> {
  try {
    const measurementsByDevice: Record<number, DevicePoint[]> = {};

    for (const [deviceKey, arr] of Object.entries(byDevice)) {
      const deviceId = Number(deviceKey);
      if (!enginesRef.current.has(deviceId)) {
        enginesRef.current.set(deviceId, new Engine());
      }
      const engine = enginesRef.current.get(deviceId)!;
      const profile = groupIdsRef.current.has(deviceId)
        ? (groupMotionProfiles.get(deviceId) ?? "person")
        : (deviceMotionProfiles[deviceId] ?? "person");
      engine.setMotionProfile(profile);
      // Ensure measurements are sorted by timestamp
      const sortedArr = [...arr].sort((a, b) => a.timestamp - b.timestamp);
      measurementsByDevice[deviceId] = sortedArr;
      engine.processMeasurements(sortedArr);
    }

    const currentSnapshots: Record<number, DevicePoint[]> = {};
    for (const deviceId of enginesRef.current.keys()) {
      const engine = enginesRef.current.get(deviceId);
      if (!engine) continue;
      const snapshot = engine.getCurrentSnapshot();
      if (snapshot.activeAnchor) {
        // Use the latest timestamp from the measurements we just processed, not engine.lastTimestamp
        const dId = Number(deviceId);
        const measurements: DevicePoint[] = measurementsByDevice[dId] ?? [];
        const lastTs = engine.lastTimestamp ?? Date.now();
        let latestMeasurementTime = lastTs;
        if (measurements.length > 0) {
          latestMeasurementTime = measurements.at(-1)?.timestamp ?? lastTs;
        }

        const timestamp = latestMeasurementTime;
        const anchorStartTs = (typeof snapshot.activeAnchor.startTimestamp === 'number' && Number.isFinite(snapshot.activeAnchor.startTimestamp)) ? snapshot.activeAnchor.startTimestamp : timestamp;
        const anchorAgeMs = Math.max(0, Date.now() - anchorStartTs);

        const point = createDevicePoint(snapshot.activeAnchor.mean, snapshot.activeAnchor.cov, timestamp, dId, refLat ?? 0, refLon ?? 0, anchorAgeMs, snapshot.activeConfidence);
        currentSnapshots[dId] = [point];
      } else {
        currentSnapshots[Number(deviceId)] = [];
      }
    }
    return currentSnapshots;
  } catch (e) {
    console.error("Error building engine snapshots:", e);
    return {};
  }
}