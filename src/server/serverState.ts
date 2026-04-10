import { buildEngineSnapshotsFromByDevice } from "./serverUtils";
import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { db } from "./db";
import { Engine } from "@/engine/engine";
import { EngineStateSchema, MotionProfileNameSchema, RawGpsPositionSchema } from "@/types";
import { numericEntries } from "@/util/record";
import { rgbToHex, colorForDevice } from "@/util/color";
import { toWebMercator } from "@/util/webMercator";
import { vlog } from "@/util/logger";
import { z } from "zod";
import type { DevicePoint, MotionProfileName, EngineEvent, AppDevice, TraccarDevice, EngineState, Vec2, RawGpsPosition } from "@/types";

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
  positionsAll: RawGpsPosition[] = [];
  private allPosById: Record<number, RawGpsPosition[]> = {};
  private historyMs: number;

  private firstAfterTimestamp(list: RawGpsPosition[], timestamp: number) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.timestamp ?? 0) <= timestamp) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private replayPositionsForEntity(id: number, replayFrom: number) {
    const replayIds = this.groupIds.has(id)
      ? Array.from(new Set(this.groups.find(g => g.id === id)?.memberDeviceIds ?? []))
      : [id];

    const replay: RawGpsPosition[] = [];
    for (const replayId of replayIds) {
      const history = this.allPosById[replayId];
      if (!history || history.length === 0) continue;
      const start = this.firstAfterTimestamp(history, replayFrom);
      if (start < history.length) replay.push(...history.slice(start));
    }

    if (replayIds.length > 1) replay.sort((a, b) => a.timestamp - b.timestamp);
    return replay;
  }

  constructor(public readonly historyDays: number) {
    this.historyMs = historyDays * 24 * 60 * 60 * 1000;
    vlog(`[ServerState] Restoring engine checkpoints...`);

    // 1. Restore Checkpoints
    (db.query(`SELECT device_id, timestamp, snapshot_json FROM engine_checkpoints ORDER BY timestamp ASC`).all())
      .forEach(row => {
        const typedRow = row as { device_id: number, timestamp: number, snapshot_json: string };
        const deviceId = typedRow.device_id;
        const checkpoints = this.engineCheckpoints[deviceId] ??= [];
        this.engines[deviceId] ??= new Engine();
        try {
          const snapshot = EngineStateSchema.parse(JSON.parse(typedRow.snapshot_json));
          checkpoints.push({ timestamp: typedRow.timestamp, snapshot });
          this.engines[deviceId]?.restoreSnapshot(snapshot);
        } catch (err) {
          console.error("Failed to parse/validate snapshot for device", deviceId, err);
        }
      });

    vlog(`[ServerState] Restoring recent positions...`);
    // 2. Restore recent raw positions so `positionsAll` is populated
    const cutoff = Date.now() - this.historyMs;
    const posRows = db.query(`SELECT device_id, geo_lng, geo_lat, accuracy, timestamp FROM position_events WHERE timestamp > ? ORDER BY timestamp ASC`).all(cutoff);
    for (const row of posRows) {
      const typedRow = row as { device_id: number, geo_lng: number, geo_lat: number, accuracy: number, timestamp: number };
      const deviceId = typedRow.device_id;
      const parsed = RawGpsPositionSchema.safeParse({
        device: deviceId,
        geo: [typedRow.geo_lng, typedRow.geo_lat],
        accuracy: typedRow.accuracy,
        timestamp: typedRow.timestamp
      });
      if (!parsed.success) {
        console.error("Failed to validate position from DB:", parsed.error);
        continue;
      }
      const p = parsed.data;
      this.allPosById[deviceId] ??= [];
      this.allPosById[deviceId].push(p);
      this.positionsAll.push(p);

      const tKey = dedupeKey(p);
      this.knownKeys.add(tKey);
      if (p.timestamp <= (this.engines[deviceId]?.lastTimestamp ?? -1)) this.processedKeys.add(tKey);
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

        const parsed = MotionProfileNameSchema.safeParse(attributes["motionProfile"]);
        const motionProfile = parsed.success ? parsed.data : null;
        const color = typeof attributes["color"] === "string" ? attributes["color"] : rgbToHex(...colorForDevice(id));
        const emoji = typeof attributes["emoji"] === "string" ? attributes["emoji"] : "";

        const base: AppDevice = { id, name, emoji, lastSeen, effectiveMotionProfile: motionProfile ?? "person", motionProfile, color, isOwner: false, memberDeviceIds: null };

        const memberIdsAttr = attributes["memberDeviceIds"];
        let group: AppDevice | null = null;
        try {
          const memberDeviceIds = z.number().array().parse(JSON.parse(memberIdsAttr as string));
          group = { ...base, emoji: base.emoji ?? "group", lastSeen: null, memberDeviceIds };
        } catch { /* ignore */ }
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
        this.deviceToGroupsMap[deviceId] ??= [];
        this.deviceToGroupsMap[deviceId].push(group.id);
      });
    }

    if (isFirst && this.positionsAll.length > 0) {
      vlog(`[ServerState] Initial catch-up for ${this.positionsAll.length} positions...`);
      this.allPosById = {};
      for (const p of this.positionsAll) {
        const ids = [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])];
        for (const id of ids) {
          this.allPosById[id] ??= [];
          this.allPosById[id].push(p);
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
        this.deviceToGroupsMap[deviceId] ??= [];
        this.deviceToGroupsMap[deviceId].push(group.id);
      });
    }
  }

  handlePositions(pts: RawGpsPosition[]) {
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
          this.allPosById[id] ??= [];
          this.allPosById[id].push(p);
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
    for (let i = 0; i < splitIdx; i++) {
      const p = this.positionsAll[i];
      if (!p) continue;
      const k = dedupeKey(p);
      this.processedKeys.delete(k);
      this.knownKeys.delete(k);
    }
    if (splitIdx > 0) this.positionsAll = this.positionsAll.slice(splitIdx);

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

    const posById: Record<number, RawGpsPosition[]> = {};
    for (const p of pts) {
      const key = dedupeKey(p);
      if (this.processedKeys.has(key)) continue;
      this.processedKeys.add(key);
      const ids = [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])];
      for (const id of ids) {
        posById[id] ??= [];
        posById[id].push(p);
      }
    }

    // Bootstrap trailing points for touched IDs
    for (const [id, batch] of numericEntries(posById)) {
      const engine = this.engines[id];
      const lastTs = engine?.lastTimestamp ?? 0;
      const history = this.allPosById[id] ?? [];
      const batchKeys = new Set(batch.map(dedupeKey));

      const trailing = history.filter(p => p.timestamp > lastTs && !batchKeys.has(dedupeKey(p)));
      if (!trailing.length) continue;
      posById[id] = [...batch, ...trailing].sort((a, b) => a.timestamp - b.timestamp);
      for (const p of trailing) this.processedKeys.add(dedupeKey(p));
    }

    if (Object.keys(posById).length === 0) return null;

    // Replay for out-of-order data
    for (const [id, newPos] of numericEntries(posById)) {
      const engine = this.engines[id];
      const first = newPos[0];
      if (!engine || !first || first.timestamp >= (engine.lastTimestamp ?? -1)) continue;

      const checkpoints = this.engineCheckpoints[id] ?? [];
      const cpIndex = checkpoints.findLastIndex(c => c.timestamp < first.timestamp);
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
      posById[id] = this.replayPositionsForEntity(id, replayFrom);
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
    const checkpointCutoff = Date.now() - this.historyMs - (24 * 60 * 60 * 1000);
    const pendingCheckpointWrites: { id: number, cp: { timestamp: number, snapshot: EngineState } }[] = [];

    for (const [id, engine] of numericEntries(this.engines)) {
      if (!engine.lastTimestamp) continue;
      engine.pruneHistory(checkpointCutoff);
      const checkpoints = this.engineCheckpoints[id] ?? [];
      const lastCp = checkpoints[checkpoints.length - 1];
      if (lastCp && (engine.lastTimestamp - lastCp.timestamp) <= CHECKPOINT_INTERVAL_MS) continue;
      const cp = { timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() };
      checkpoints.push(cp);
      this.engineCheckpoints[id] = checkpoints;
      pendingCheckpointWrites.push({ id, cp });

      if (checkpoints.length > MAX_CHECKPOINTS) {
        const oldest = checkpoints.shift();
        if (oldest) db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp = ?`, [id, oldest.timestamp]);
      }
    }

    if (pendingCheckpointWrites.length) {
      const stmt = db.prepare(`INSERT OR REPLACE INTO engine_checkpoints (device_id, timestamp, snapshot_json) VALUES (?, ?, ?)`);
      db.transaction(() => pendingCheckpointWrites.forEach(item => stmt.run(item.id, item.cp.timestamp, JSON.stringify(item.cp.snapshot))))();
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
      if (allowedDeviceIds.has(id)) entities[id] = dev;
    }

    // 2. Process directly allowed groups and include only their members.
    // This keeps shared-group visibility stable without exposing unrelated devices.
    for (const group of this.groups) {
      if (!allowedDeviceIds.has(group.id)) continue;

      for (const mId of (group.memberDeviceIds ?? [])) {
        groupMemberIds.add(mId);
        if (this.devices[mId]) entities[mId] = this.devices[mId];
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
