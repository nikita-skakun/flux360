import { buildEngineSnapshotsFromByDevice } from "./serverUtils";
import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { db } from "./db";
import { Engine } from "@/engine/engine";
import { EngineStateSchema, NormalizedPositionSchema } from "@/types";
import { numericEntries } from "@/util/record";
import { rgbToHex, colorForDevice } from "@/util/color";
import { toWebMercator } from "@/util/webMercator";
import { vlog } from "@/util/logger";
import { z } from "zod";
import type { NormalizedPosition, DevicePoint, MotionProfileName, EngineEvent, AppDevice, TraccarDevice, EngineState, Vec2 } from "@/types";

function dedupeKey(p: { device: number; timestamp: number; geo: Vec2 }) {
  return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
}

export class ServerState {
  devices: Record<number, AppDevice> = {};
  groups: AppDevice[] = [];
  deviceToGroupsMap: Record<number, number[]> = {};
  groupIds = new Set<number>();
  engines: Record<number, Engine> = {};
  engineCheckpoints: Record<number, { timestamp: number; snapshot: EngineState }[]> = {};
  knownKeys = new Set<string>();
  processedKeys = new Set<string>();
  backfilled = new Set<number>();
  inProgressBackfills = new Set<number>();
  private rawTraccarDevices: Record<number, TraccarDevice> = {};

  activePointsByDevice: Record<number, DevicePoint[]> = {};
  eventsByDevice: Record<number, EngineEvent[]> = {};
  positionsAll: NormalizedPosition[] = [];
  private allPosById: Record<number, NormalizedPosition[]> = {};
  private historyMs: number;

  constructor(public readonly historyDays: number) {
    this.historyMs = historyDays * 24 * 60 * 60 * 1000;
    vlog(`[ServerState] Restoring engine checkpoints...`);

    // 1. Restore Checkpoints
    (db.query(`SELECT device_id, timestamp, snapshot_json FROM engine_checkpoints ORDER BY timestamp ASC`).all())
      .forEach(row => {
        const typedRow = row as { device_id: number, timestamp: number, snapshot_json: string | object };
        const checkpoints = this.engineCheckpoints[typedRow.device_id] ??= [];
        this.engines[typedRow.device_id] ??= new Engine();
        try {
          const rawSnapshot = typeof typedRow.snapshot_json === 'string' ? JSON.parse(typedRow.snapshot_json) as unknown : typedRow.snapshot_json;
          const snapshot = EngineStateSchema.parse(rawSnapshot);
          checkpoints.push({ timestamp: typedRow.timestamp, snapshot });
          this.engines[typedRow.device_id]?.restoreSnapshot(snapshot);
        } catch (err) {
          console.error("Failed to parse/validate snapshot for device", typedRow.device_id, err);
        }
      });

    vlog(`[ServerState] Restoring recent positions...`);
    // 2. Restore recent raw positions so `positionsAll` is populated
    const cutoff = Date.now() - this.historyMs;
    const posRows = db.query(`SELECT device_id, geo_lng, geo_lat, accuracy, timestamp FROM position_events WHERE timestamp > ? ORDER BY timestamp ASC`).all(cutoff);
    for (const row of posRows) {
      const typedRow = row as { device_id: number, geo_lng: number, geo_lat: number, accuracy: number, timestamp: number };
      try {
        const p = NormalizedPositionSchema.parse({
          device: typedRow.device_id,
          geo: [typedRow.geo_lng, typedRow.geo_lat],
          accuracy: typedRow.accuracy,
          timestamp: typedRow.timestamp
        });
        this.positionsAll.push(p);

        let list = this.allPosById[p.device];
        if (!list) this.allPosById[p.device] = list = [];
        list.push(p);

        const tKey = dedupeKey(p);
        this.knownKeys.add(tKey);

        const engine = this.engines[p.device];
        if (engine?.lastTimestamp && p.timestamp <= engine.lastTimestamp) {
          this.processedKeys.add(tKey);
        }
      } catch (err) {
        console.error("Failed to validate position from DB:", err);
      }
    }
    vlog(`[ServerState] Restored ${posRows.length} trailing positions. ${Object.keys(this.engines).length} engines ready.`);
  }

  handleDevices(devices: TraccarDevice[]) {
    const isFirst = Object.keys(this.rawTraccarDevices).length === 0;

    for (const d of devices) {
      if (d.id) this.rawTraccarDevices[d.id] = d;
    }

    const processed = Object.values(this.rawTraccarDevices)
      .map(device => {
        const { attributes, id, name, lastUpdate } = device;
        const lastSeen = lastUpdate ? (Date.parse(lastUpdate)) : null;
        if (lastSeen && lastSeen < Date.now() - this.historyMs) return null;

        const profileAttr = attributes["motionProfile"];
        const profile = (profileAttr === "person" || profileAttr === "car") ? profileAttr : null;
        const color = (typeof attributes["color"] === "string") ? attributes["color"] : rgbToHex(...colorForDevice(id));
        const emoji = typeof attributes["emoji"] === "string" ? attributes["emoji"] : "";

        const base: AppDevice = { id, name, emoji, lastSeen, effectiveMotionProfile: profile ?? "person", motionProfile: profile, color, isOwner: false, memberDeviceIds: null };

        const memberIdsAttr = attributes["memberDeviceIds"];
        let group: AppDevice | null = null;
        if (typeof memberIdsAttr === "string") {
          try {
            const memberDeviceIds = z.array(z.number()).parse(JSON.parse(memberIdsAttr));
            group = { ...base, emoji: base.emoji ? base.emoji : 'group', lastSeen: null, memberDeviceIds };
          } catch { /* ignore */ }
        }
        return { id, base, group };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    // Merge new devices/groups instead of replacing—preserves existing state
    // and ensures shared devices stay visible when partial device lists are synced
    this.devices = { ...this.devices, ...Object.fromEntries(processed.map(d => [d.id, d.base])) };

    const newGroups = processed.map(d => d.group).filter((g): g is AppDevice => g !== null);
    this.groups = [...this.groups.filter(g => !newGroups.some(ng => ng.id === g.id)), ...newGroups];

    for (const group of this.groups) {
      if (group.memberDeviceIds) {
        let max: number | null = null;
        for (const mid of group.memberDeviceIds) {
          const ts = this.devices[mid]?.lastSeen ?? null;
          if (ts && (max === null || ts > max)) max = ts;
        }
        group.lastSeen = max;
      }
    }

    this.deviceToGroupsMap = {};
    this.groupIds.clear();
    for (const group of this.groups) {
      this.groupIds.add(group.id);
      group.memberDeviceIds?.forEach(deviceId => {
        const list = this.deviceToGroupsMap[deviceId] ?? [];
        list.push(group.id);
        this.deviceToGroupsMap[deviceId] = list;
      });
    }

    if (isFirst && this.positionsAll.length > 0) {
      vlog(`[ServerState] Initial catch-up for ${this.positionsAll.length} positions...`);
      this.allPosById = {};
      for (const p of this.positionsAll) {
        const ids = [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])];
        for (const id of ids) {
          let list = this.allPosById[id];
          if (!list) this.allPosById[id] = list = [];
          list.push(p);
        }
      }
    }

    vlog(`[ServerState] Handled ${devices.length} updates. Total: ${Object.keys(this.devices).length}`);
  }

  deleteGroup(groupId: number) {
    delete this.rawTraccarDevices[groupId];
    delete this.devices[groupId];
    this.groups = this.groups.filter(group => group.id !== groupId);
    delete this.deviceToGroupsMap[groupId];
    this.groupIds.delete(groupId);
    delete this.activePointsByDevice[groupId];
    delete this.eventsByDevice[groupId];
    delete this.engines[groupId];
    delete this.engineCheckpoints[groupId];
    db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [groupId]);

    this.deviceToGroupsMap = {};
    this.groupIds.clear();
    for (const group of this.groups) {
      this.groupIds.add(group.id);
      group.memberDeviceIds?.forEach(deviceId => {
        const list = this.deviceToGroupsMap[deviceId] ?? [];
        list.push(group.id);
        this.deviceToGroupsMap[deviceId] = list;
      });
    }
  }

  handlePositions(pts: NormalizedPosition[]) {
    if (pts.length === 0) return null;

    const newPts = pts.filter(p => {
      const k = dedupeKey(p);
      if (this.knownKeys.has(k)) return false;
      this.knownKeys.add(k);
      return true;
    });

    if (newPts.length > 0) {
      // 1. Save to Database
      db.transaction(() => {
        const stmt = db.prepare(`INSERT INTO position_events (device_id, geo_lng, geo_lat, accuracy, timestamp) VALUES (?, ?, ?, ?, ?)`);
        for (const p of newPts) {
          stmt.run(p.device, p.geo[0], p.geo[1], p.accuracy, p.timestamp);
        }
      })();

      // 2. Update memory index
      this.positionsAll.push(...newPts);
      this.positionsAll.sort((a, b) => a.timestamp - b.timestamp);

      const touchedIds = new Set<number>();
      for (const p of newPts) {
        const ids = [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])];
        for (const id of ids) {
          let list = this.allPosById[id];
          if (!list) this.allPosById[id] = list = [];
          list.push(p);
          touchedIds.add(id);
        }
      }
      for (const id of touchedIds) {
        this.allPosById[id]?.sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    // 3. Prune old data
    const cutoff = Date.now() - this.historyMs;
    const splitIdx = this.positionsAll.findIndex(p => p.timestamp > cutoff);
    if (splitIdx > 0) {
      for (let i = 0; i < splitIdx; i++) {
        const p = this.positionsAll[i];
        if (!p) continue;
        const k = dedupeKey(p);
        this.processedKeys.delete(k);
        this.knownKeys.delete(k);
      }
      this.positionsAll = this.positionsAll.slice(splitIdx);
    }

    for (const [id, list] of numericEntries(this.allPosById)) {
      const split = list.findIndex(p => p.timestamp > cutoff);
      if (split === -1) delete this.allPosById[id];
      else if (split > 0) this.allPosById[id] = list.slice(split);
    }

    if (Math.random() < 0.05) db.run('DELETE FROM position_events WHERE timestamp < ?', [cutoff]);

    // 4. Compute Engine State
    const profiles: Record<number, MotionProfileName> = {};
    for (const [id, d] of numericEntries(this.devices)) {
      profiles[id] = d.effectiveMotionProfile;
    }

    const posById: Record<number, NormalizedPosition[]> = {};
    for (const p of pts) {
      const key = dedupeKey(p);
      if (!this.processedKeys.has(key)) {
        this.processedKeys.add(key);
        const ids = [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])];
        for (const id of ids) {
          let list = posById[id];
          if (!list) posById[id] = list = [];
          list.push(p);
        }
      }
    }

    // Bootstrap trailing points for touched IDs
    for (const [id, batch] of numericEntries(posById)) {
      const engine = this.engines[id];
      const lastTs = engine?.lastTimestamp ?? 0;
      const history = this.allPosById[id] ?? [];
      const batchKeys = new Set(batch.map(dedupeKey));

      const trailing = history.filter(p => p.timestamp > lastTs && !batchKeys.has(dedupeKey(p)));
      if (trailing.length) {
        const combined = [...batch, ...trailing].sort((a, b) => a.timestamp - b.timestamp);
        posById[id] = combined;
        for (const p of trailing) this.processedKeys.add(dedupeKey(p));
      }
    }

    if (Object.keys(posById).length === 0) return null;

    // Replay for out-of-order data
    for (const [id, newPos] of numericEntries(posById)) {
      const engine = this.engines[id];
      const first = newPos[0];
      if (!engine?.lastTimestamp || !first || first.timestamp >= engine.lastTimestamp) continue;

      const minTs = first.timestamp;
      const checkpoints = this.engineCheckpoints[id] ?? [];
      const cpIndex = checkpoints.findLastIndex(c => c.timestamp < minTs);
      const cp = cpIndex >= 0 ? checkpoints[cpIndex] : null;

      if (cp) {
        engine.restoreSnapshot(cp.snapshot);
        this.engineCheckpoints[id] = checkpoints.slice(0, cpIndex + 1);
        db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp > ?`, [id, cp.timestamp]);
      } else {
        this.engines[id] = new Engine();
        this.engineCheckpoints[id] = [];
        db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [id]);
      }

      const replayFrom = cp?.timestamp ?? 0;
      const relevantIds = this.groupIds.has(id) ? new Set(this.groups.find(g => g.id === id)?.memberDeviceIds ?? []) : [id];
      const historical = Array.from(relevantIds).flatMap(rId => this.allPosById[rId] ?? []).filter(p => p.timestamp > replayFrom).sort((a, b) => a.timestamp - b.timestamp);
      posById[id] = historical;
    }

    const rawByDevice: Record<number, DevicePoint[]> = {};
    for (const [id, arr] of numericEntries(posById)) {
      rawByDevice[id] = arr.map(p => ({
        mean: toWebMercator(p.geo),
        accuracy: p.accuracy,
        geo: p.geo,
        device: id,
        timestamp: p.timestamp,
        anchorStartTimestamp: p.timestamp,
        confidence: 0,
        sourceDeviceId: this.groupIds.has(id) ? p.device : null,
      }));
    }

    const motionProfiles: Record<number, MotionProfileName> = { ...profiles };
    for (const g of this.groups) {
      motionProfiles[g.id] = g.motionProfile ?? ((g.memberDeviceIds?.some(mId => profiles[mId] === "car")) ? "car" : "person");
    }

    const result = buildEngineSnapshotsFromByDevice(rawByDevice, this.engines, motionProfiles);

    // Prune and Checkpoint
    const cpCutoff = Date.now() - (this.historyMs * 2);
    const cpToDb: { id: number, cp: { timestamp: number, snapshot: EngineState } }[] = [];

    for (const [id, engine] of numericEntries(this.engines)) {
      if (!engine.lastTimestamp) continue;
      engine.pruneHistory(cpCutoff);
      const checkpoints = this.engineCheckpoints[id] ?? [];
      const lastCp = checkpoints[checkpoints.length - 1];
      if (!lastCp || (engine.lastTimestamp - lastCp.timestamp) > CHECKPOINT_INTERVAL_MS) {
        const cp = { timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() };
        checkpoints.push(cp);
        this.engineCheckpoints[id] = checkpoints;
        cpToDb.push({ id, cp });

        if (checkpoints.length > MAX_CHECKPOINTS) {
          const oldest = checkpoints.shift();
          if (oldest) db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp = ?`, [id, oldest.timestamp]);
        }
      }
    }

    if (cpToDb.length) {
      const stmt = db.prepare(`INSERT OR REPLACE INTO engine_checkpoints (device_id, timestamp, snapshot_json) VALUES (?, ?, ?)`);
      db.transaction(() => cpToDb.forEach(item => stmt.run(item.id, item.cp.timestamp, JSON.stringify(item.cp.snapshot))))();
    }

    const beforeCount = pts[0]?.device !== undefined ? (this.eventsByDevice[pts[0].device]?.length ?? 0) : 0;
    Object.assign(this.activePointsByDevice, result.positionsByDevice);
    Object.assign(this.eventsByDevice, result.eventsByDevice);

    for (const id in this.eventsByDevice) {
      this.eventsByDevice[id]?.sort((a, b) => b.start - a.start);
    }

    if (pts[0]?.device !== undefined) {
      const afterCount = this.eventsByDevice[pts[0].device]?.length ?? 0;
      vlog(`[ServerState] handlePositions: ${pts.length} pts. Events: ${beforeCount} -> ${afterCount}`);
    }

    return { engineStates: result.engineStatesByDevice, events: result.eventsByDevice };
  }

  refreshGroupFromMembers(groupId: number) {
    const group = this.groups.find(g => g.id === groupId);
    if (!group) return;

    if (!group.memberDeviceIds || group.memberDeviceIds.length === 0) {
      delete this.engines[groupId];
      delete this.engineCheckpoints[groupId];
      delete this.activePointsByDevice[groupId];
      delete this.eventsByDevice[groupId];
      db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [groupId]);
      return;
    }

    const profile = group.motionProfile ?? (
      group.memberDeviceIds.some(memberId => this.devices[memberId]?.effectiveMotionProfile === "car") ? "car" : "person"
    );

    const memberHistory = group.memberDeviceIds
      .flatMap(memberId => this.allPosById[memberId] ?? [])
      .sort((a, b) => a.timestamp - b.timestamp);
    if (memberHistory.length === 0) {
      delete this.engines[groupId];
      delete this.engineCheckpoints[groupId];
      delete this.activePointsByDevice[groupId];
      delete this.eventsByDevice[groupId];
      db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [groupId]);
      return;
    }

    const rawByDevice: Record<number, DevicePoint[]> = {
      [groupId]: memberHistory.map(position => ({
        mean: toWebMercator(position.geo),
        accuracy: position.accuracy,
        geo: position.geo,
        device: position.device,
        timestamp: position.timestamp,
        anchorStartTimestamp: position.timestamp,
        confidence: 0,
        sourceDeviceId: null,
      }))
    };

    const groupEngines: Record<number, Engine> = {};
    const result = buildEngineSnapshotsFromByDevice(rawByDevice, groupEngines, { [groupId]: profile });
    this.engines[groupId] = groupEngines[groupId]!;
    delete this.engineCheckpoints[groupId];
    db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [groupId]);
    Object.assign(this.activePointsByDevice, result.positionsByDevice);
    Object.assign(this.eventsByDevice, result.eventsByDevice);

    for (const id in this.eventsByDevice) {
      this.eventsByDevice[id]?.sort((a, b) => b.start - a.start);
    }
  }

  getMetadata(allowedDeviceIds: Set<number>) {
    const entities: Record<number, AppDevice> = {};
    const groupMemberIds = new Set<number>();

    // 1. Collect all allowed devices as individual entities first
    for (const [id, dev] of numericEntries(this.devices)) {
      if (!allowedDeviceIds.has(id)) continue;
      entities[id] = dev;
    }

    // 2. Process directly allowed groups and include only their members.
    // This keeps shared-group visibility stable without exposing unrelated devices.
    for (const group of this.groups) {
      if (!allowedDeviceIds.has(group.id)) continue;

      if (group.memberDeviceIds) {
        for (const mId of group.memberDeviceIds) {
          groupMemberIds.add(mId);

          if (this.devices[mId]) entities[mId] = this.devices[mId];
        }
      }

      entities[group.id] = group;
    }

    // 3. Identify root entities (not inside any directly allowed group)
    const rootIds = Object.keys(entities)
      .map(Number)
      .filter(id => !groupMemberIds.has(id));

    return {
      entities,
      rootIds,
    };
  }
}
