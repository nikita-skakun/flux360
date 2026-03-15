import { computeBounds } from "@/util/geo";
import { Engine } from "@/engine/engine";
import { fromWebMercator } from "@/util/webMercator";
import { RawTraccarPositionSchema } from "@/types";
import type { DevicePoint, MotionProfileName, EngineEvent, Vec2, EngineState, NormalizedPosition } from "@/types";

export function dedupeKey(p: { device: number; timestamp: number; geo: Vec2 }) {
    return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
}

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
    enginesRef: Map<number, Engine>,
    groupIdsRef: Set<number>,
    groupMotionProfiles: Map<number, MotionProfileName>,
    deviceMotionProfiles: Record<number, MotionProfileName>
): { positionsByDevice: Record<number, DevicePoint[]>; engineStatesByDevice: Map<number, EngineState[]>; eventsByDevice: Record<number, EngineEvent[]> } {
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
                : deviceMotionProfiles[deviceId] ?? "person";
            engine.setMotionProfile(profile);
            engine.processMeasurements(arr);
            engine.refineHistory();
        });

        // 2. Build current state for all engines
        const positionsByDevice: Record<number, DevicePoint[]> = {};
        const engineStatesByDevice = new Map<number, EngineState[]>();
        const eventsByDevice: Record<number, EngineEvent[]> = {};

        for (const [deviceId, engine] of enginesRef.entries()) {
            try {
                const snapshot = engine.getState();
                const events = [...engine.closed];

                if (!snapshot?.draft) {
                    positionsByDevice[deviceId] = [];
                    eventsByDevice[deviceId] = events;
                    continue;
                }

                engineStatesByDevice.set(deviceId, [snapshot]);
                const draft = snapshot.draft;
                const endTs = snapshot.lastTimestamp ?? Date.now();

                const isStationary = draft.type === 'stationary';
                const isMotion = draft.type === 'motion';
                const distance = isMotion ? engine.computePathLength(draft.path) : 0;
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
                    events.push({
                        type: 'motion',
                        start: draft.start,
                        end: endTs,
                        startAnchor: draft.startAnchor,
                        endAnchor: lastPt.mean,
                        path: draft.path.map(p => p.mean),
                        distance,
                        isDraft: true,
                        bounds: computeBounds(draft.path.map(p => p.mean))
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
                engineStatesByDevice.set(deviceId, []);
            }
        }

        return { positionsByDevice, engineStatesByDevice, eventsByDevice };
    } catch (e) {
        console.error("Error building engine snapshots:", e);
        return { positionsByDevice: {}, engineStatesByDevice: new Map(), eventsByDevice: {} };
    }
}
