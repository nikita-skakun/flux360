import { db } from "./db";
import { dedupeKey, buildEngineSnapshotsFromByDevice } from "./serverUtils";
import { Engine } from "@/engine/engine";
import { toWebMercator } from "@/util/webMercator";
import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { rgbToHex, colorForDevice } from "@/util/color";
import type { NormalizedPosition, DevicePoint, MotionProfileName, EngineEvent, Timestamp, AppDevice, TraccarDevice, EngineState } from "@/types";

export class ServerState {
  devices: Record<number, AppDevice> = {};
  groups: AppDevice[] = [];
  deviceToGroupsMap = new Map<number, number[]>();
  groupIds = new Set<number>();
  engines = new Map<number, Engine>();
  engineCheckpoints = new Map<number, { timestamp: Timestamp; snapshot: EngineState }[]>();
  processedKeys = new Set<string>();
  backfilledDeviceIds = new Set<number>();
  private rawTraccarDevices = new Map<number, TraccarDevice>();

  engineSnapshotsByDevice: Record<number, DevicePoint[]> = {};
  eventsByDevice: Record<number, EngineEvent[]> = {};
  positionsAll: NormalizedPosition[] = [];
  private allPosById = new Map<number, NormalizedPosition[]>();
  private historyMs: number;

  constructor(public readonly historyDays: number) {
    this.historyMs = historyDays * 24 * 60 * 60 * 1000;
    this.restoreFromDb();
  }

  private restoreFromDb() {
    // 1. Restore Checkpoints
    (db.query(`SELECT device_id, timestamp, snapshot_json FROM engine_checkpoints ORDER BY timestamp ASC`).all() as { device_id: number, timestamp: number, snapshot_json: string }[])
      .forEach(row => {
        if (!this.engineCheckpoints.has(row.device_id)) {
          this.engineCheckpoints.set(row.device_id, []);
          this.engines.set(row.device_id, new Engine());
        }
        try {
          const snapshot = typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) as EngineState : row.snapshot_json as EngineState;
          this.engineCheckpoints.get(row.device_id)?.push({ timestamp: row.timestamp as Timestamp, snapshot });
          this.engines.get(row.device_id)?.restoreSnapshot(snapshot);
        } catch (err) {
          console.error("Failed to parse snapshot for device", row.device_id, err);
        }
      });

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

      const ids = [p.device, ...(this.deviceToGroupsMap.get(p.device) ?? [])];
      for (const id of ids) {
        let list = this.allPosById.get(id);
        if (!list) this.allPosById.set(id, list = []);
        list.push(p);
      }

      const engine = this.engines.get(p.device);
      // If we have a restored engine state, mark points covered by that state as already processed.
      // This prevents the catch-up process from triggering a destructive "replay" of old data.
      if (engine?.lastTimestamp && p.timestamp <= engine.lastTimestamp) {
        this.processedKeys.add(dedupeKey(p));
      }
    }
    console.log(`[ServerState] Restored ${posRows.length} trailing positions from position_events table.`);

    console.log(`[ServerState] Restored ${this.engines.size} engines. Initial events count:`,
      Object.fromEntries(Array.from(this.engines.entries()).map(([id, eng]) => [id, eng.closed.length])));

    console.log(`[ServerState] Triggering initial catch-up with ${this.positionsAll.length} trailing positions...`);

    // 3. Trigger initial catch-up to process trailing positions into engines
    this.processPositions([], false);

    // 4. Initialize the events and snapshots caches from the restored/caught-up engines
    console.log(`[ServerState] Syncing caches for ${this.engines.size} engines...`);
    let counts = 0;
    for (const [id, engine] of this.engines) {
      this.eventsByDevice[id] = [...engine.closed];
      if (engine.closed.length > 0) counts++;
      if (engine.draft) {
        this.engineSnapshotsByDevice[id] = [...engine.draft.recent];
      }
    }

    console.log(`[ServerState] Catch-up complete. Devices with cached events: ${counts}. Total eventsByDevice keys: ${Object.keys(this.eventsByDevice).length}`);
  }

  getLastTimestamp(deviceId: number): Timestamp | null {
    return this.engines.get(deviceId)?.lastTimestamp ?? null;
  }

  getFirstTimestamp(deviceId: number): Timestamp | null {
    const positions = this.positionsAll.filter(p => p.device === deviceId);
    const first = positions[0];
    return first ? first.timestamp : null;
  }

  handleDevices(devices: TraccarDevice[]) {
    // 1. Merge updates into raw master map
    for (const d of devices) {
      if (!d.id) continue;
      this.rawTraccarDevices.set(d.id, d);
    }

    // 2. Rebuild derived state from FULL master map
    const processedDevices = Array.from(this.rawTraccarDevices.values())
      .map(device => {
        const { attributes, id, name, lastUpdate } = device;
        const lastSeen = lastUpdate ? (Date.parse(lastUpdate) as Timestamp) : null;
        if (lastSeen && lastSeen < Date.now() - this.historyMs) return null;

        const profileAttr = attributes["motionProfile"];
        const profile = (profileAttr === "person" || profileAttr === "car") ? profileAttr : null;
        const color = (typeof attributes["color"] === "string") ? attributes["color"] : rgbToHex(...colorForDevice(id));

        const base: AppDevice = {
          id,
          name,
          emoji: typeof attributes["emoji"] === 'string' ? attributes["emoji"] : "",
          lastSeen,
          effectiveMotionProfile: profile ?? "person",
          motionProfile: profile,
          color,
          isOwner: false,
          memberDeviceIds: null,
        };

        const memberIdsAttr = attributes["memberDeviceIds"];
        let group: AppDevice | null = null;
        if (typeof memberIdsAttr === "string") {
          try {
            group = {
              ...base,
              emoji: base.emoji || 'group',
              lastSeen: null,
              memberDeviceIds: JSON.parse(memberIdsAttr) as number[],
            };
          } catch { /* Ignore invalid JSON */ }
        }

        return { id, base, group };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    this.devices = Object.fromEntries(processedDevices.map(d => [d.id, d.base]));
    this.groups = processedDevices.map(d => d.group).filter((g): g is AppDevice => g !== null);

    // Compute group lastSeen from member devices (in-place)
    for (const group of this.groups) {
      if (group.memberDeviceIds) {
        let max: Timestamp | null = null;
        for (const mid of group.memberDeviceIds) {
          const ts = this.devices[mid]?.lastSeen ?? null;
          if (ts && (max === null || ts > max)) max = ts;
        }
        group.lastSeen = max;
      }
    }

    const deviceToGroupsMap = new Map<number, number[]>();
    const groupIds = new Set<number>();

    for (const group of this.groups) {
      groupIds.add(group.id);
      if (group.memberDeviceIds) {
        for (const deviceId of group.memberDeviceIds) {
          const groupList = deviceToGroupsMap.get(deviceId) ?? [];
          groupList.push(group.id);
          deviceToGroupsMap.set(deviceId, groupList);
        }
      }
    }

    this.deviceToGroupsMap = deviceToGroupsMap;
    this.groupIds = groupIds;

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

    if (newPosArr.length > 0) {
      this.positionsAll.push(...newPosArr);
      this.positionsAll.sort((a, b) => a.timestamp - b.timestamp);

      // Incrementally update our per-device/group index
      for (const p of newPosArr) {
        const ids = [p.device, ...(this.deviceToGroupsMap.get(p.device) ?? [])];
        for (const id of ids) {
          let list = this.allPosById.get(id);
          if (!list) this.allPosById.set(id, list = []);
          list.push(p);
          list.sort((a, b) => a.timestamp - b.timestamp);
        }
      }
    }

    // Prune positions and processedKeys older than history window
    const cutoff = Date.now() - this.historyMs;

    // Find points to prune
    const toPrune = this.positionsAll.filter(p => p.timestamp <= cutoff);
    if (toPrune.length > 0) {
      for (const p of toPrune) {
        this.processedKeys.delete(dedupeKey(p));
      }
      this.positionsAll = this.positionsAll.filter(p => p.timestamp > cutoff);

      // Also prune the per-device index
      for (const [id, list] of this.allPosById) {
        const filtered = list.filter(p => p.timestamp > cutoff);
        if (filtered.length === 0) {
          this.allPosById.delete(id);
        } else {
          this.allPosById.set(id, filtered);
        }
      }
    }

    // Also periodically cleanup the db table of old data so it doesn't grow forever
    if (saveToDb && Math.random() < 0.05) { // ~ 5% chance per batch
      db.run('DELETE FROM position_events WHERE timestamp < ?', [cutoff]);
    }

    const motionProfiles: Record<number, MotionProfileName> = Object.fromEntries(
      Object.entries(this.devices).map(([id, d]) => [id, d.effectiveMotionProfile])
    );

    const result = this.computeProcessedPositionsInternal(
      newPosArr,
      this.allPosById,
      this.processedKeys,
      this.deviceToGroupsMap,
      this.groups,
      this.engines,
      this.engineCheckpoints,
      this.groupIds,
      motionProfiles
    );

    if (result) {
      const firstPos = newPosArr[0];
      const deviceId = firstPos?.device;
      const beforeCount = deviceId !== undefined ? (this.eventsByDevice[deviceId]?.length ?? 0) : 0;

      let replayedCount = 0;
      let newCount = 0;
      for (const p of newPosArr) {
        const eng = this.engines.get(p.device);
        if (eng?.lastTimestamp && p.timestamp <= eng.lastTimestamp) {
          replayedCount++;
        } else {
          newCount++;
        }
      }

      this.engineSnapshotsByDevice = { ...this.engineSnapshotsByDevice, ...result.engineSnapshotsByDevice };
      this.eventsByDevice = { ...this.eventsByDevice, ...result.eventsByDevice };

      // Ensure events are sorted by start timestamp descending for consistent timeline
      for (const id in this.eventsByDevice) {
        const events = this.eventsByDevice[id];
        if (events && events.length > 1) {
          events.sort((a, b) => b.start - a.start);
        }
      }

      if (deviceId !== undefined) {
        const afterCount = this.eventsByDevice[deviceId]?.length ?? 0;
        const isMulti = new Set(newPosArr.map(p => p.device)).size > 1;
        console.log(`[ServerState] processPositions for ${isMulti ? 'multiple devices' : deviceId}: ${newPosArr.length} pts (${replayedCount} replayed, ${newCount} new). Events: ${beforeCount} -> ${afterCount}`);
      }
    } else {
      console.log(`[ServerState] No processing needed for batch of ${newPosArr.length} pts`);
    }

    const totalEvents = Object.values(this.eventsByDevice).reduce((acc, evs) => acc + evs.length, 0);
    console.log(`[ServerState] Total events in memory: ${totalEvents}`);

    return result;
  }

  private computeProcessedPositionsInternal(
    newPosArr: NormalizedPosition[],
    allPosById: Map<number, NormalizedPosition[]>,
    processedKeys: Set<string>,
    deviceToGroupsMap: Map<number, number[]>,
    groupDevices: AppDevice[],
    engines: Map<number, Engine>,
    engineCheckpoints: Map<number, { timestamp: Timestamp; snapshot: EngineState }[]>,
    groupIds: Set<number>,
    motionProfiles: Record<number, MotionProfileName>
  ): { engineSnapshotsByDevice: Record<number, DevicePoint[]>, eventsByDevice: Record<number, EngineEvent[]> } | null {
    if (newPosArr.length === 0 && Array.from(engines.values()).every(e => !e.draft)) {
      return null;
    }

    // 1. Identify which IDs were touched by THIS batch
    const posById = new Map<number, NormalizedPosition[]>();
    const groupIdsTouched = new Set<number>();

    for (const p of newPosArr) {
      const ids = [p.device, ...(deviceToGroupsMap.get(p.device) ?? [])];
      const key = dedupeKey(p);

      // If we've already processed this point fully, we skip putting it in posById
      // But we still need to know it touched these IDs for potential "mush" processing
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

    // 1.5 Bootstrap trailing points for all engines from historical buffer
    // ONLY for devices that actually received points in this batch
    for (const [id, points] of posById) {
      const engine = engines.get(id);
      const lastTs = engine?.lastTimestamp ?? 0;
      const historical = allPosById.get(id) ?? [];

      const trailing = historical
        .filter(p => p.timestamp > lastTs && !points.some(pp => dedupeKey(pp) === dedupeKey(p)))
        .sort((a, b) => a.timestamp - b.timestamp);

      if (trailing.length) {
        // Merge with points from current batch, ensuring sort
        const combined = [...points, ...trailing].sort((a, b) => a.timestamp - b.timestamp);
        posById.set(id, combined);

        // Ensure processedKeys is updated so we don't double-process 
        for (const p of trailing) {
          processedKeys.add(dedupeKey(p));
        }
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
      const relevantIds = groupIds.has(id) ? new Set(groupDevices.find(g => g.id === id)?.memberDeviceIds ?? []) : [id];
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
      g.motionProfile ?? ((g.memberDeviceIds?.some(mId => motionProfiles[mId] === "car")) ? "car" : "person")
    ]));

    const result = buildEngineSnapshotsFromByDevice(rawByDevice, engines, groupIds, groupMotionProfiles, motionProfiles);

    // 5. Final pass: Prune and Checkpoint
    const eventsCutoff = Date.now() - (this.historyMs * 2);
    const cpToDb: { id: number, cp: { timestamp: Timestamp, snapshot: EngineState } }[] = [];

    for (const id of engines.keys()) {
      const engine = engines.get(id)!;
      if (engine.lastTimestamp) {
        // Prune
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

  getMetadata(allowedDeviceIds: Set<number>) {
    const entities: Record<number, AppDevice> = {};
    const groupMemberIds = new Set<number>();

    // 1. Collect all allowed devices as individual entities first
    for (const [idStr, dev] of Object.entries(this.devices)) {
      const id = Number(idStr);
      if (!allowedDeviceIds.has(id)) continue;
      entities[id] = dev;
    }

    // 2. Process groups: track hierarchy
    for (const group of this.groups) {
      if (!allowedDeviceIds.has(group.id)) continue;

      if (group.memberDeviceIds) {
        for (const mId of group.memberDeviceIds) {
          groupMemberIds.add(mId);
        }
      }

      entities[group.id] = group;
    }

    // 3. Identify root entities (not inside any group)
    const rootIds = Array.from(allowedDeviceIds).filter(id => !groupMemberIds.has(id));

    return {
      entities,
      rootIds,
    };
  }
}
