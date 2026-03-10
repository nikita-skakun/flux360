import { db } from "./db";
import { dedupeKey, buildEngineSnapshotsFromByDevice } from "@/util/appUtils";
import { Engine, type EngineState } from "@/engine/engine";
import { fromWebMercator, toWebMercator } from "@/util/webMercator";
import { MOTION_PROFILES, CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { rgbToHex, colorForDevice } from "@/util/color";
import type { NormalizedPosition, DevicePoint, GroupDevice, MotionProfileName, EngineEvent, Timestamp, BaseAppDevice, TraccarDevice } from "@/types";

export class ServerState {
  devices: Record<number, BaseAppDevice> = {};
  groups: GroupDevice[] = [];
  deviceToGroupsMap = new Map<number, number[]>();
  groupIds = new Set<number>();
  engines = new Map<number, Engine>();
  engineCheckpoints = new Map<number, { timestamp: Timestamp; snapshot: EngineState }[]>();
  processedKeys = new Set<string>();
  private rawTraccarDevices = new Map<number, TraccarDevice>();

  engineSnapshotsByDevice: Record<number, DevicePoint[]> = {};
  eventsByDevice: Record<number, EngineEvent[]> = {};

  // We maintain a 24h trailing window of positions to reply if needed
  positionsAll: NormalizedPosition[] = [];

  constructor() {
    this.restoreFromDb();
  }

  private restoreFromDb() {
    // 1. Restore Checkpoints
    const cpRows = db.query(`SELECT device_id, timestamp, snapshot_json FROM engine_checkpoints ORDER BY timestamp ASC`).all() as { device_id: number, timestamp: number, snapshot_json: string }[];
    for (const row of cpRows) {
      if (!this.engineCheckpoints.has(row.device_id)) {
        this.engineCheckpoints.set(row.device_id, []);
        this.engines.set(row.device_id, new Engine());
      }
      try {
        const snapshot = JSON.parse(row.snapshot_json) as EngineState;
        this.engineCheckpoints.get(row.device_id)!.push({ timestamp: row.timestamp as Timestamp, snapshot });
        const engine = this.engines.get(row.device_id)!;
        // The last checkpoint will leave the engine in its final state
        engine.restoreSnapshot(snapshot);
      } catch {
        console.error("Failed to parse snapshot for device", row.device_id);
      }
    }

    // 2. Restore recent raw positions so `positionsAll` is populated
    const twentyFourHrsAgo = Date.now() - 24 * 60 * 60 * 1000;
    const posRows = db.query(`SELECT device_id, geo_lng, geo_lat, accuracy, timestamp FROM position_events WHERE timestamp > ? ORDER BY timestamp ASC`).all(twentyFourHrsAgo) as { device_id: number, geo_lng: number, geo_lat: number, accuracy: number, timestamp: number }[];
    for (const row of posRows) {
      const p: NormalizedPosition = {
        device: row.device_id,
        geo: [row.geo_lng, row.geo_lat],
        accuracy: row.accuracy,
        timestamp: row.timestamp as Timestamp
      };
      this.positionsAll.push(p);
      this.processedKeys.add(dedupeKey(p));
    }

    console.log(`[ServerState] Restored ${this.engines.size} engines and ${this.positionsAll.length} trailing positions.`);

    for (const [deviceId, engine] of this.engines) {
      const snapshot = engine.getCurrentSnapshot();

      // Always include closed historical events
      const events = [...engine.closed];

      // Add current draft if there is one
      if (snapshot?.draft) {
        const { draft, timestamp } = snapshot;
        const stats = engine.computeStats(draft.recent);
        this.engineSnapshotsByDevice[deviceId] = [{
          mean: stats.mean,
          timestamp: (timestamp ?? Date.now()) as Timestamp,
          device: deviceId,
          geo: fromWebMercator(stats.mean),
          accuracy: 5,
          anchorStartTimestamp: draft.start,
          confidence: snapshot.activeConfidence,
          sourceDeviceId: null
        }];

        if (draft.type === 'stationary') {
          events.push({
            type: 'stationary',
            start: draft.start,
            end: (timestamp ?? Date.now()) as Timestamp,
            mean: stats.mean,
            variance: stats.variance,
            isDraft: true
          });
        } else {
          events.push({
            type: 'motion',
            start: draft.start,
            end: (timestamp ?? Date.now()) as Timestamp,
            startAnchor: draft.startAnchor,
            endAnchor: draft.path[draft.path.length - 1]!.mean,
            path: draft.path.map(p => p.mean),
            distance: engine.computePathLength(draft.path),
            isDraft: true
          });
        }
      } else {
        this.engineSnapshotsByDevice[deviceId] = [];
      }

      this.eventsByDevice[deviceId] = events;

      // If no active draft, still provide the last known position for map markers
      if (!this.engineSnapshotsByDevice[deviceId] || this.engineSnapshotsByDevice[deviceId].length === 0) {
        const lastPos = this.positionsAll.filter(p => p.device === deviceId).pop();
        if (lastPos) {
          this.engineSnapshotsByDevice[deviceId] = [{
            device: deviceId,
            timestamp: lastPos.timestamp,
            geo: lastPos.geo,
            mean: toWebMercator(lastPos.geo),
            accuracy: lastPos.accuracy,
            confidence: 1.0,
            anchorStartTimestamp: lastPos.timestamp,
            sourceDeviceId: null
          }];
        }
      }
    }
  }

  handleDevices(devices: TraccarDevice[]) {
    // 1. Merge updates into raw master map
    for (const d of devices) {
      if (!d.id) continue;
      this.rawTraccarDevices.set(d.id, d);
    }

    const nextDevices: Record<number, BaseAppDevice> = {};
    const groupDevicesMap = new Map<number, GroupDevice>();

    // 2. Rebuild derived state from FULL master map
    for (const device of this.rawTraccarDevices.values()) {
      const attributes = device.attributes;
      const id = device.id;

      const emoji = (attributes["emoji"] as string) ?? "";
      const lastSeen = device.lastUpdate ? (Date.parse(device.lastUpdate) as Timestamp) : null;

      let motionProfile: MotionProfileName = "person";
      const profileAttr = attributes["motionProfile"];
      if (typeof profileAttr === "string" && (profileAttr === "person" || profileAttr === "car")) {
        motionProfile = profileAttr;
      }
      const motionProfileActual = (typeof profileAttr === "string" && (profileAttr === "person" || profileAttr === "car")) ? profileAttr : null;

      const color = typeof attributes["color"] === "string" ? attributes["color"] : rgbToHex(...colorForDevice(id));

      nextDevices[id] = {
        id,
        name: device.name,
        emoji,
        lastSeen,
        effectiveMotionProfile: motionProfile,
        motionProfile: motionProfileActual,
        color,
      };

      const memberDeviceIdsAttr = attributes["memberDeviceIds"];
      if (typeof memberDeviceIdsAttr === "string") {
        try {
          const memberDeviceIds = JSON.parse(memberDeviceIdsAttr) as unknown;
          if (Array.isArray(memberDeviceIds) && memberDeviceIds.every((mId: unknown): mId is number => typeof mId === "number")) {
            groupDevicesMap.set(id, {
              id,
              name: device.name,
              emoji: (attributes["emoji"] as string) ?? 'group',
              color: color ?? '#3b82f6',
              lastSeen: null,
              isGroup: true,
              memberDeviceIds,
              motionProfile: motionProfileActual,
              effectiveMotionProfile: motionProfile,
              isOwner: false,
            });
          }
        } catch { /* Ignore invalid JSON */ }
      }
    }

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

    this.deviceToGroupsMap = deviceToGroupsMap;
    this.groupIds = groupIds;
    this.groups = Array.from(groupDevicesMap.values());
    this.devices = nextDevices;

    console.log(`[ServerState] Handled ${devices.length} updates. Total devices in state: ${Object.keys(this.devices).length}`);
    console.log(`[ServerState] Handled ${devices.length} updates. Total devices in state: ${Object.keys(this.devices).length}`);
  }

  handlePositions(positions: NormalizedPosition[]) {
    if (positions.length === 0) return null;
    return this.processPositions(positions, true);
  }

  private processPositions(newPosArr: NormalizedPosition[], saveToDb: boolean) {
    if (saveToDb) {
      const stmt = db.prepare(`INSERT INTO position_events (device_id, geo_lng, geo_lat, accuracy, timestamp) VALUES (?, ?, ?, ?, ?)`);
      const insertMany = db.transaction((positions: NormalizedPosition[]) => {
        for (const p of positions) {
          stmt.run(p.device, p.geo[0], p.geo[1], p.accuracy, p.timestamp);
        }
      });
      insertMany(newPosArr);
    }

    this.positionsAll.push(...newPosArr);
    this.positionsAll.sort((a, b) => a.timestamp - b.timestamp);

    // Prune positions older than 24 hours
    const twentyFourHrsAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.positionsAll = this.positionsAll.filter(p => p.timestamp > twentyFourHrsAgo);

    // Also periodically cleanup the db table of old data so it doesn't grow forever
    if (saveToDb && Math.random() < 0.05) { // ~ 5% chance per batch
      db.run('DELETE FROM position_events WHERE timestamp < ?', [twentyFourHrsAgo]);
    }

    const motionProfiles: Record<number, MotionProfileName> = Object.fromEntries(
      Object.entries(this.devices).map(([id, d]) => [id, d.effectiveMotionProfile])
    );

    const result = this.computeProcessedPositionsInternal(
      this.positionsAll,
      this.processedKeys,
      this.deviceToGroupsMap,
      this.groups,
      this.engines,
      this.engineCheckpoints,
      this.groupIds,
      motionProfiles
    );

    if (result) {
      this.engineSnapshotsByDevice = result.engineSnapshotsByDevice;
      this.eventsByDevice = result.eventsByDevice;
    }

    return result;
  }

  private computeProcessedPositionsInternal(
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

        let replayFrom: Timestamp = 0 as Timestamp;
        if (cp) {
          engine.restoreSnapshot(cp.snapshot);
          replayFrom = cp.timestamp;
          // Prune invalid future checkpoints
          const validCheckpoints = checkpoints.slice(0, cpIndex + 1);
          engineCheckpoints.set(deviceId, validCheckpoints);

          // Delete invalid future checkpoints from Db
          db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp > ?`, [deviceId, cp.timestamp]);
        } else {
          engines.set(deviceId, new Engine());
          engineCheckpoints.set(deviceId, []);
          replayFrom = 0 as Timestamp;
          // Delete all checkpoints for device
          db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [deviceId]);
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
        sourceDeviceId: groupIds.has(deviceId) ? p.device : null,
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

    // Prune closed events older than 48 hours to match client timeline display
    const fortyEightHoursAgo = Date.now() - 48 * 60 * 60 * 1000;
    if (positionsAll.length > 0) {
      for (const [deviceId, engine] of engines.entries()) {
        const profile = motionProfiles[deviceId] ?? "person";
        const profileConfig = MOTION_PROFILES[profile];
        engine.refineHistory(profileConfig);
        engine.pruneHistory(fortyEightHoursAgo as Timestamp);
      }
    }

    // Update checkpoints
    const insertCpStmt = db.prepare(`INSERT OR REPLACE INTO engine_checkpoints (device_id, timestamp, snapshot_json) VALUES (?, ?, ?)`);
    const saveCheckpoints = db.transaction((checkpointsToSave: { deviceId: number, cp: { timestamp: Timestamp, snapshot: EngineState } }[]) => {
      for (const item of checkpointsToSave) {
        insertCpStmt.run(item.deviceId, item.cp.timestamp, JSON.stringify(item.cp.snapshot));
      }
    });
    const checkpointsToDb = [];

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
          const cp = { timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() };
          checkpoints.push(cp);
          checkpointsToDb.push({ deviceId, cp });

          if (checkpoints.length > MAX_CHECKPOINTS) {
            const oldest = checkpoints.shift(); // Keep last N
            if (oldest) {
              db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp = ?`, [deviceId, oldest.timestamp]);
            }
          }
        }
      }
    }

    if (checkpointsToDb.length > 0) saveCheckpoints(checkpointsToDb);

    return {
      engineSnapshotsByDevice: result.positionsByDevice,
      eventsByDevice: result.eventsByDevice,
    };
  }
}
