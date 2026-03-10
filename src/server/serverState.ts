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
  positionsAll: NormalizedPosition[] = [];
  private historyMs: number;

  constructor(public readonly historyDays: number) {
    this.historyMs = historyDays * 24 * 60 * 60 * 1000;
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
    const cutoff = Date.now() - this.historyMs;
    const posRows = db.query(`SELECT device_id, geo_lng, geo_lat, accuracy, timestamp FROM position_events WHERE timestamp > ? ORDER BY timestamp ASC`).all(cutoff) as { device_id: number, geo_lng: number, geo_lat: number, accuracy: number, timestamp: number }[];
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
      const { attributes, id, name, lastUpdate } = device;
      const lastSeen = lastUpdate ? (Date.parse(lastUpdate) as Timestamp) : null;

      // Filter devices not seen within the history window
      if (lastSeen && lastSeen < Date.now() - this.historyMs) continue;

      const profileAttr = attributes["motionProfile"];
      const motionProfile: MotionProfileName = (profileAttr === "person" || profileAttr === "car") ? profileAttr : "person";
      const motionProfileActual = (profileAttr === "person" || profileAttr === "car") ? profileAttr : null;
      const color = (typeof attributes["color"] === "string") ? attributes["color"] : rgbToHex(...colorForDevice(id));

      nextDevices[id] = {
        id,
        name,
        emoji: (attributes["emoji"] as string) ?? "",
        lastSeen,
        effectiveMotionProfile: motionProfile,
        motionProfile: motionProfileActual,
        color,
      };

      const memberDeviceIdsAttr = attributes["memberDeviceIds"];
      if (typeof memberDeviceIdsAttr === "string") {
        try {
          const memberDeviceIds = JSON.parse(memberDeviceIdsAttr);
          if (Array.isArray(memberDeviceIds)) {
            groupDevicesMap.set(id, {
              id,
              name,
              emoji: (attributes["emoji"] as string) ?? 'group',
              color: color ?? '#3b82f6',
              lastSeen: null,
              isGroup: true,
              memberDeviceIds: memberDeviceIds.filter((mId): mId is number => typeof mId === "number"),
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

    // Prune positions older than history window
    const cutoff = Date.now() - this.historyMs;
    this.positionsAll = this.positionsAll.filter(p => p.timestamp > cutoff);

    // Also periodically cleanup the db table of old data so it doesn't grow forever
    if (saveToDb && Math.random() < 0.05) { // ~ 5% chance per batch
      db.run('DELETE FROM position_events WHERE timestamp < ?', [cutoff]);
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
    if (!positionsAll?.length) return null;

    // 1. Index everything and find what needs processing
    const allPosById = new Map<number, NormalizedPosition[]>();
    const posById = new Map<number, NormalizedPosition[]>();
    const groupIdsTouched = new Set<number>();

    for (const p of positionsAll) {
      const ids = [p.device, ...(deviceToGroupsMap.get(p.device) ?? [])];
      for (const id of ids) {
        let list = allPosById.get(id);
        if (!list) allPosById.set(id, list = []);
        list.push(p);
      }

      const key = dedupeKey(p);
      if (!processedKeys.has(key)) {
        processedKeys.add(key);
        for (const id of ids) {
          let list = posById.get(id);
          if (!list) posById.set(id, list = []);
          list.push(p);
          if (groupIds.has(id)) groupIdsTouched.add(id);
        }
      }
    }

    // Bootstrap missing group engines
    for (const group of groupDevices) {
      if (!engines.has(group.id)) {
        const historical = group.memberDeviceIds.flatMap(mId => allPosById.get(mId) ?? []).sort((a, b) => a.timestamp - b.timestamp);
        if (historical.length) posById.set(group.id, historical);
      }
    }

    if (!posById.size) return null;

    // 2. Handle out-of-order data and replay
    for (const [id, newPos] of posById) {
      const engine = engines.get(id);
      if (!engine?.lastTimestamp || !newPos[0] || newPos[0].timestamp >= engine.lastTimestamp) continue;

      const minTs = newPos[0].timestamp;
      const checkpoints = engineCheckpoints.get(id) ?? [];
      const cpIndex = checkpoints.findLastIndex(c => c.timestamp < minTs);
      const cp = cpIndex >= 0 ? checkpoints[cpIndex] : null;

      if (cp) {
        engine.restoreSnapshot(cp.snapshot);
        engineCheckpoints.set(id, checkpoints.slice(0, cpIndex + 1));
        db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp > ?`, [id, cp.timestamp]);
      } else {
        engines.set(id, new Engine());
        engineCheckpoints.set(id, []);
        db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [id]);
      }

      const replayFrom = cp?.timestamp ?? 0;
      const relevantIds = groupIds.has(id) ? new Set(groupDevices.find(g => g.id === id)?.memberDeviceIds) : [id];
      const historical = Array.from(relevantIds).flatMap(rId => allPosById.get(rId) ?? []).filter(p => p.timestamp > replayFrom).sort((a, b) => a.timestamp - b.timestamp);
      posById.set(id, historical);
    }

    // 3. Convert to DevicePoint for engine processing
    const rawByDevice: Record<number, DevicePoint[]> = {};
    for (const [id, arr] of posById) {
      rawByDevice[id] = arr.map(p => ({
        mean: toWebMercator(p.geo),
        accuracy: p.accuracy,
        geo: p.geo,
        device: id,
        timestamp: p.timestamp,
        anchorStartTimestamp: p.timestamp,
        confidence: 0,
        sourceDeviceId: groupIds.has(id) ? p.device : null,
      }));
    }

    // 4. Determine motion profiles and build snapshots
    const groupMotionProfiles = new Map(groupDevices.map(g => [
      g.id,
      g.motionProfile || (g.memberDeviceIds.some(mId => motionProfiles[mId] === "car") ? "car" : "person")
    ]));

    const result = buildEngineSnapshotsFromByDevice(rawByDevice, engines, groupIds, groupMotionProfiles, motionProfiles);

    // 5. Final pass: Prune and Checkpoint
    const eventsCutoff = Date.now() - (this.historyMs * 2);
    const cpToDb: { id: number, cp: { timestamp: Timestamp, snapshot: EngineState } }[] = [];

    for (const id of engines.keys()) {
      const engine = engines.get(id)!;
      if (engine.lastTimestamp) {
        // Prune
        engine.refineHistory(MOTION_PROFILES[motionProfiles[id] ?? "person"]);
        engine.pruneHistory(eventsCutoff as Timestamp);

        // Checkpoint
        const checkpoints = engineCheckpoints.get(id) ?? [];
        const lastCp = checkpoints[checkpoints.length - 1];
        if (rawByDevice[id]?.length && (!lastCp || (engine.lastTimestamp - lastCp.timestamp) > CHECKPOINT_INTERVAL_MS)) {
          const cp = { timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() };
          checkpoints.push(cp);
          engineCheckpoints.set(id, checkpoints);
          cpToDb.push({ id, cp });

          if (checkpoints.length > MAX_CHECKPOINTS) {
            const oldest = checkpoints.shift();
            if (oldest) db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp = ?`, [id, oldest.timestamp]);
          }
        }
      }
    }

    if (cpToDb.length) {
      const stmt = db.prepare(`INSERT OR REPLACE INTO engine_checkpoints (device_id, timestamp, snapshot_json) VALUES (?, ?, ?)`);
      db.transaction(() => cpToDb.forEach(item => stmt.run(item.id, item.cp.timestamp, JSON.stringify(item.cp.snapshot))))();
    }

    return {
      engineSnapshotsByDevice: result.positionsByDevice,
      eventsByDevice: result.eventsByDevice,
    };
  }
}
