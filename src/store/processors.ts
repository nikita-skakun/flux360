import { dedupeKey, buildEngineSnapshotsFromByDevice } from '@/util/appUtils';
import { Engine, type EngineState } from '@/engine/engine';
import { MOTION_PROFILES, CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from '@/engine/motionDetector';
import { rgbToHex } from '@/util/color';
import { toWebMercator } from '@/util/webMercator';
import type { NormalizedPosition, DevicePoint, GroupDevice, MotionProfileName, EngineEvent, Timestamp } from '@/types';
import type { TraccarDevice } from '@/api/devices';

type ColorFunction = (id: number) => [number, number, number];

export function parseDevices(
    devices: TraccarDevice[],
    colorForDevice: ColorFunction
) {
    const nameMap: Record<number, string> = {};
    const iconMap: Record<number, string> = {};
    const lastSeenMap: Record<number, Timestamp | null> = {};
    const motionProfileMap: Record<number, MotionProfileName> = {};
    const motionProfileAttributeMap: Record<number, MotionProfileName | null> = {};
    const colorAttributeMap: Record<number, string | null> = {};
    const groupDevicesMap = new Map<number, GroupDevice>();

    for (const device of devices) {
        nameMap[device.id] = device.name;
        iconMap[device.id] = device.emoji;
        lastSeenMap[device.id] = device.lastSeen;

        let profile: MotionProfileName = "person";
        const profileAttr = device.attributes["motionProfile"];
        if (typeof profileAttr === "string" && (profileAttr === "person" || profileAttr === "car")) {
            profile = profileAttr;
        }
        motionProfileMap[device.id] = profile;
        motionProfileAttributeMap[device.id] = (typeof profileAttr === "string" && (profileAttr === "person" || profileAttr === "car")) ? profileAttr : null;

        colorAttributeMap[device.id] = typeof device.attributes["color"] === "string" && device.attributes["color"] || rgbToHex(...colorForDevice(device.id));

        // Check if it's a group device
        const memberDeviceIdsAttr = device.attributes["memberDeviceIds"];
        if (typeof memberDeviceIdsAttr === "string") {
            try {
                const memberDeviceIds = JSON.parse(memberDeviceIdsAttr) as unknown;
                if (Array.isArray(memberDeviceIds) && memberDeviceIds.every((id: unknown): id is number => typeof id === "number")) {
                    let color = rgbToHex(...colorForDevice(device.id));
                    const colorAttr = device.attributes["color"];
                    if (typeof colorAttr === "string") {
                        color = colorAttr;
                    }

                    let groupMotionProfile: MotionProfileName | null = null;
                    const mpAttr = device.attributes["motionProfile"];
                    if (typeof mpAttr === "string" && (mpAttr === "person" || mpAttr === "car")) {
                        groupMotionProfile = mpAttr;
                    }

                    groupDevicesMap.set(device.id, {
                        id: device.id,
                        name: device.name,
                        emoji: device.emoji,
                        color,
                        memberDeviceIds,
                        motionProfile: groupMotionProfile,
                    });
                }
            } catch {
                // Ignore invalid JSON
            }
        }
    }

    // Update refs for group mapping
    const deviceToGroupsMap = new Map<number, number[]>();
    const groupIds = new Set<number>();
    for (const group of groupDevicesMap.values()) {
        groupIds.add(group.id);
        for (const deviceId of group.memberDeviceIds) {
            const groups = deviceToGroupsMap.get(deviceId) ?? [];
            groups.push(group.id);
            deviceToGroupsMap.set(deviceId, groups);
        }
    }

    return {
        nameMap,
        iconMap,
        lastSeenMap,
        motionProfileMap,
        motionProfileAttributeMap,
        colorAttributeMap,
        groups: Array.from(groupDevicesMap.values()),
        deviceToGroupsMap,
        groupIds
    };
}

export function computeProcessedPositions(
    positionsAll: NormalizedPosition[],
    processedKeys: Set<string>,
    deviceToGroupsMap: Map<number, number[]>,
    groupDevices: GroupDevice[],
    engines: Map<number, Engine>,
    engineCheckpoints: Map<number, { timestamp: Timestamp; snapshot: EngineState }[]>,
    groupIds: Set<number>,
    motionProfiles: Record<number, MotionProfileName>
): { engineSnapshotsByDevice: Record<number, DevicePoint[]>, eventsByDevice: Record<number, EngineEvent[]> } | null {
    if (!positionsAll || positionsAll.length === 0) return null;

    // Pre-index all positions by deviceId once to avoid O(N*E) filters
    const allPosByDevice = new Map<number, NormalizedPosition[]>();
    for (const p of positionsAll) {
        // Add to individual device list
        let list = allPosByDevice.get(p.device);
        if (!list) {
            list = [];
            allPosByDevice.set(p.device, list);
        }
        list.push(p);

        // Also add to any group this device belongs to
        const groups = deviceToGroupsMap.get(p.device);
        if (groups) {
            for (const groupId of groups) {
                let groupList = allPosByDevice.get(groupId);
                if (!groupList) {
                    groupList = [];
                    allPosByDevice.set(groupId, groupList);
                }
                groupList.push(p);
            }
        }
    }

    // Filter out already processed positions using dedupeKey
    const newPositions = positionsAll.filter((p: NormalizedPosition) => {
        const key = dedupeKey(p);
        if (processedKeys.has(key)) return false;
        processedKeys.add(key);
        return true;
    });

    // Group new positions by device AND by any groups they belong to
    const posByDevice: Record<number, NormalizedPosition[]> = {};
    const groupIdsTouched = new Set<number>();

    for (const p of newPositions) {
        // Add position to the original device
        (posByDevice[p.device] ||= []).push(p);

        // Also add position to any groups this device belongs to
        const groups = deviceToGroupsMap.get(p.device);
        if (groups) {
            for (const groupId of groups) {
                groupIdsTouched.add(groupId);
                (posByDevice[groupId] ||= []).push(p);
            }
        }
    }

    // Bootstrap missing group engines (including new groups)
    for (const group of groupDevices) {
        if (!engines.has(group.id)) {
            const historical: NormalizedPosition[] = [];
            for (const memberId of group.memberDeviceIds) {
                const memberPos = allPosByDevice.get(memberId);
                if (memberPos) historical.push(...memberPos);
            }
            if (historical.length > 1) {
                historical.sort((a, b) => a.timestamp - b.timestamp);
            }
            if (historical.length > 0) {
                posByDevice[group.id] = historical;
            }
        }
    }

    if (Object.keys(posByDevice).length === 0) return null;

    if (groupIdsTouched.size > 0) {
        const membersByGroup = new Map<number, number[]>();
        for (const group of groupDevices) {
            membersByGroup.set(group.id, group.memberDeviceIds);
        }
        for (const groupId of groupIdsTouched) {
            const memberIds = membersByGroup.get(groupId);
            if (!memberIds || memberIds.length === 0) continue;
            const memberSet = new Set(memberIds);
            posByDevice[groupId] = newPositions.filter((p) => memberSet.has(p.device));
        }
    }

    // Check for out-of-order data and replay if necessary
    for (const [key, newPositionsForDevice] of Object.entries(posByDevice)) {
        const deviceId = Number(key);
        const engine = engines.get(deviceId);
        if (!engine?.lastTimestamp) continue;

        if (newPositionsForDevice.length === 0 || !newPositionsForDevice[0]) continue;
        const minTs = newPositionsForDevice[0].timestamp;

        if (minTs < engine.lastTimestamp) {
            const checkpoints = engineCheckpoints.get(deviceId) ?? [];
            let cp = null;
            let cpIndex = -1;
            for (let i = checkpoints.length - 1; i >= 0; i--) {
                const checkpoint = checkpoints[i];
                if (checkpoint && checkpoint.timestamp < minTs) {
                    cp = checkpoint;
                    cpIndex = i;
                    break;
                }
            }

            let replayFrom: Timestamp = 0;
            if (cp) {
                engine.restoreSnapshot(cp.snapshot);
                replayFrom = cp.timestamp;
                // Prune invalid future checkpoints
                const validCheckpoints = checkpoints.slice(0, cpIndex + 1);
                engineCheckpoints.set(deviceId, validCheckpoints);
            } else {
                engines.set(deviceId, new Engine());
                engineCheckpoints.set(deviceId, []);
                replayFrom = 0;
            }

            // Gather all historical positions > replayFrom
            let relevantDeviceIds = new Set<number>();
            if (groupIds.has(deviceId)) {
                const group = groupDevices.find(g => g.id === deviceId);
                if (group) {
                    group.memberDeviceIds.forEach(id => relevantDeviceIds.add(id));
                }
            } else {
                relevantDeviceIds.add(deviceId);
            }

            const historical: NormalizedPosition[] = [];
            for (const dId of relevantDeviceIds) {
                const devicePos = allPosByDevice.get(dId);
                if (devicePos) {
                    for (const p of devicePos) {
                        if (p.timestamp > replayFrom) historical.push(p);
                    }
                }
            }
            if (historical.length > 1) {
                historical.sort((a, b) => a.timestamp - b.timestamp);
            }
            posByDevice[deviceId] = historical;
        }
    }

    const rawByDevice: Record<number, DevicePoint[]> = {};
    for (const [deviceKey, arr] of Object.entries(posByDevice)) {
        const deviceId = Number(deviceKey);
        rawByDevice[deviceId] = arr.map((p) => ({
            mean: toWebMercator(p.geo),
            accuracy: p.accuracy,
            geo: p.geo,
            device: deviceId,
            timestamp: p.timestamp,
            anchorStartTimestamp: p.timestamp,
            confidence: 0,
            sourceDeviceId: groupIds.has(deviceId) ? p.device : undefined,
        }));
    }

    const groupMotionProfiles = new Map<number, MotionProfileName>();
    for (const group of groupDevices) {
        if (group.motionProfile) {
            groupMotionProfiles.set(group.id, group.motionProfile);
            continue;
        }
        let profile: MotionProfileName = "person";
        for (const memberId of group.memberDeviceIds) {
            if ((motionProfiles[memberId] ?? "person") === "car") {
                profile = "car";
                break;
            }
        }
        groupMotionProfiles.set(group.id, profile);
    }

    const result = buildEngineSnapshotsFromByDevice(rawByDevice, engines, groupIds, groupMotionProfiles, motionProfiles);

    // Prune old motion segments from engines based on the current data window
    if (positionsAll.length > 0) {
        // Find the oldest timestamp in the current dataset
        let minTimestamp: Timestamp = Infinity;
        for (const p of positionsAll) {
            if (p.timestamp < minTimestamp) minTimestamp = p.timestamp;
        }

        if (minTimestamp !== Infinity) {
            for (const [deviceId, engine] of engines.entries()) {
                const profile = motionProfiles[deviceId] ?? "person";
                const profileConfig = MOTION_PROFILES[profile];
                engine.refineHistory(profileConfig);
                engine.pruneHistory(minTimestamp);
            }
        }
    }

    // Update checkpoints
    for (const [key, points] of Object.entries(rawByDevice)) {
        if (points.length === 0) continue;
        const deviceId = Number(key);
        const engine = engines.get(deviceId);
        if (engine?.lastTimestamp) {
            let checkpoints = engineCheckpoints.get(deviceId);
            if (!checkpoints) {
                checkpoints = [];
                engineCheckpoints.set(deviceId, checkpoints);
            }
            const lastCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
            // Checkpoint every 5 minutes
            if (!lastCp || (engine.lastTimestamp - lastCp.timestamp) > CHECKPOINT_INTERVAL_MS) {
                checkpoints.push({ timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() });
                if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift(); // Keep last N
            }
        }
    }

    return {
        engineSnapshotsByDevice: result.positionsByDevice,
        eventsByDevice: result.eventsByDevice,
    };
}
