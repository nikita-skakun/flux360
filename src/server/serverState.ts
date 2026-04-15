import { buildEngineSnapshotsFromByDevice } from "./serverUtils";
import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { db } from "./db";
import { Engine } from "@/engine/engine";
import { EngineStateSchema, MotionProfileNameSchema, RawGpsPositionSchema } from "@/types";
import { numericEntries } from "@/util/record";
import { rgbToHex, colorForDevice } from "@/util/color";
import { toWebMercator } from "@/util/webMercator";
import { vlog } from "@/util/logger";
import type { DevicePoint, MotionProfileName, EngineEvent, AppDevice, TraccarDevice, EngineState, Vec2, RawGpsPosition, DeviceMetadata } from "@/types";

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
  deviceMetadataById: Record<number, DeviceMetadata> = {};
  private rawTraccarDevices: Record<number, TraccarDevice> = {};

  activePointsByDevice: Record<number, DevicePoint[]> = {};
  eventsByDevice: Record<number, EngineEvent[]> = {};
  positionsAll: RawGpsPosition[] = [];
  private allPosById: Record<number, RawGpsPosition[]> = {};
  private historyMs: number;

  static toDbGroupId(appGroupId: number) {
    if (appGroupId >= 0) return null;
    return -appGroupId;
  }

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

  private clearGroupRuntime(groupId: number) {
    delete this.activePointsByDevice[groupId];
    delete this.eventsByDevice[groupId];
    delete this.engines[groupId];
    delete this.engineCheckpoints[groupId];
    delete this.allPosById[groupId];
    db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ?`, [groupId]);
  }

  private rebuildGroupDerivedFields() {
    for (const group of this.groups) {
      const members = group.memberDeviceIds ?? [];

      let max: number | null = null;
      for (const memberId of members) {
        const ts = this.devices[memberId]?.lastSeen ?? null;
        if (ts !== null && (max === null || ts > max)) max = ts;
      }

      group.lastSeen = max;
      group.effectiveMotionProfile = group.motionProfile ?? (members.some(memberId => this.devices[memberId]?.effectiveMotionProfile === "car") ? "car" : "person");
      group.color ??= rgbToHex(...colorForDevice(group.id));
    }

    this.deviceToGroupsMap = {};
    this.groupIds.clear();

    for (const group of this.groups) {
      this.groupIds.add(group.id);
      for (const deviceId of group.memberDeviceIds ?? []) {
        this.deviceToGroupsMap[deviceId] ??= [];
        this.deviceToGroupsMap[deviceId].push(group.id);
      }
    }
  }

  private rebuildPositionIndexFromAllPositions() {
    this.allPosById = {};
    for (const p of this.positionsAll) {
      const ids = [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])];
      for (const id of ids) {
        this.allPosById[id] ??= [];
        this.allPosById[id].push(p);
      }
    }
  }

  private refreshGroupFromMembers(groupId: number) {
    const group = this.groups.find(g => g.id === groupId);
    if (!group) {
      this.clearGroupRuntime(groupId);
      return;
    }

    const memberDeviceIds = Array.from(new Set(group.memberDeviceIds ?? []));
    if (memberDeviceIds.length === 0) {
      this.clearGroupRuntime(groupId);
      return;
    }

    const profile = group.motionProfile ?? (
      memberDeviceIds.some(memberId => this.devices[memberId]?.effectiveMotionProfile === "car") ? "car" : "person"
    );

    const memberHistory = memberDeviceIds
      .flatMap(memberId => this.allPosById[memberId] ?? [])
      .sort((a, b) => a.timestamp - b.timestamp);

    if (memberHistory.length === 0) {
      this.clearGroupRuntime(groupId);
      return;
    }

    const rawByDevice: Record<number, DevicePoint[]> = {
      [groupId]: memberHistory.map(position => ({
        mean: toWebMercator(position.geo),
        accuracy: position.accuracy,
        geo: position.geo,
        device: groupId,
        timestamp: position.timestamp,
        anchorStartTimestamp: position.timestamp,
        confidence: 0,
        sourceDeviceId: position.device,
      }))
    };

    const groupEngines: Record<number, Engine> = {};
    const result = buildEngineSnapshotsFromByDevice(rawByDevice, groupEngines, { [groupId]: profile });

    this.clearGroupRuntime(groupId);
    this.engines[groupId] = groupEngines[groupId] ?? new Engine();
    this.activePointsByDevice[groupId] = result.positionsByDevice[groupId] ?? [];
    this.eventsByDevice[groupId] = (result.eventsByDevice[groupId] ?? []).sort((a, b) => b.start - a.start);
  }

  private reloadGroupsFromDB(rebuildHistory: boolean) {
    const previousGroupIds = new Set(this.groups.map(group => group.id));

    this.groups = this.loadGroupsFromDB();
    this.rebuildGroupDerivedFields();

    for (const oldId of previousGroupIds) {
      if (!this.groupIds.has(oldId)) this.clearGroupRuntime(oldId);
    }

    if (rebuildHistory) {
      this.rebuildPositionIndexFromAllPositions();
      for (const group of this.groups) {
        this.refreshGroupFromMembers(group.id);
      }
    }
  }

  loadDeviceMetadata(deviceIds: number[]) {
    const out: Record<number, DeviceMetadata> = {};
    if (deviceIds.length === 0) return out;

    const placeholders = deviceIds.map(() => "?").join(",");
    const rows = db.query(`SELECT deviceId, emoji, color, motionProfile FROM device_metadata WHERE deviceId IN (${placeholders})`).all(...deviceIds) as {
      deviceId: number;
      emoji: string | null;
      color: string | null;
      motionProfile: MotionProfileName | null;
    }[];

    for (const row of rows) {
      out[row.deviceId] = {
        name: this.rawTraccarDevices[row.deviceId]?.name ?? `Device ${row.deviceId}`,
        emoji: row.emoji,
        color: row.color,
        motionProfile: row.motionProfile,
      };
    }

    return out;
  }

  materializeAppDevices(): Record<number, AppDevice> {
    const result: Record<number, AppDevice> = {};

    for (const raw of Object.values(this.rawTraccarDevices)) {
      const id = raw.id;
      const lastSeen = raw.lastUpdate ? Date.parse(raw.lastUpdate) : null;
      if (lastSeen && lastSeen < Date.now() - this.historyMs) continue;

      const metadata = this.deviceMetadataById[id] ?? {
        emoji: null,
        color: null,
        motionProfile: null,
      };

      const effectiveMotionProfile = metadata.motionProfile ?? "person";
      result[id] = {
        id,
        name: raw.name,
        emoji: metadata.emoji ?? raw.name.trim().charAt(0),
        color: metadata.color ?? rgbToHex(...colorForDevice(id)),
        lastSeen,
        effectiveMotionProfile,
        motionProfile: metadata.motionProfile,
        isOwner: false,
        memberDeviceIds: null,
      };
    }

    return result;
  }

  loadGroupsFromDB(): AppDevice[] {
    const groupRows = db.query(`SELECT id, name, emoji, color, motionProfile FROM groups ORDER BY id ASC`).all() as {
      id: number;
      name: string;
      emoji: string | null;
      color: string | null;
      motionProfile: string | null;
    }[];

    const memberRows = db.query(`SELECT groupId, deviceId FROM group_members ORDER BY groupId ASC, deviceId ASC`).all() as {
      groupId: number;
      deviceId: number;
    }[];

    const membersByGroup: Record<number, number[]> = {};
    for (const row of memberRows) {
      const appGroupId = -row.groupId;
      membersByGroup[appGroupId] ??= [];
      membersByGroup[appGroupId].push(row.deviceId);
    }

    return groupRows.map(row => {
      const parsed = MotionProfileNameSchema.safeParse(row.motionProfile);
      const motionProfile = parsed.success ? parsed.data : null;

      return {
        id: -row.id,
        name: row.name,
        emoji: row.emoji ?? row.name.trim().charAt(0),
        color: row.color ?? rgbToHex(...colorForDevice(-row.id)),
        lastSeen: null,
        effectiveMotionProfile: motionProfile ?? "person",
        motionProfile,
        isOwner: false,
        memberDeviceIds: membersByGroup[-row.id] ?? [],
      };
    });
  }

  constructor(public readonly historyDays: number) {
    this.historyMs = historyDays * 24 * 60 * 60 * 1000;
    vlog(`[ServerState] Restoring engine checkpoints...`);

    // 1. Restore Checkpoints
    (db.query(`SELECT deviceId, timestamp, snapshotJson FROM engine_checkpoints ORDER BY timestamp ASC`).all())
      .forEach(row => {
        const typedRow = row as { deviceId: number, timestamp: number, snapshotJson: string };
        const deviceId = typedRow.deviceId;
        const checkpoints = this.engineCheckpoints[deviceId] ??= [];
        this.engines[deviceId] ??= new Engine();
        try {
          const snapshot = EngineStateSchema.parse(JSON.parse(typedRow.snapshotJson));
          checkpoints.push({ timestamp: typedRow.timestamp, snapshot });
          this.engines[deviceId]?.restoreSnapshot(snapshot);
        } catch (err) {
          console.error("Failed to parse/validate snapshot for device", deviceId, err);
        }
      });

    vlog(`[ServerState] Restoring recent positions...`);
    // 2. Restore recent raw positions so `positionsAll` is populated
    const cutoff = Date.now() - this.historyMs;
    const posRows = db.query(`SELECT deviceId, geoLon, geoLat, accuracy, timestamp FROM position_events WHERE timestamp > ? ORDER BY timestamp ASC`).all(cutoff);
    for (const row of posRows) {
      const typedRow = row as { deviceId: number, geoLon: number, geoLat: number, accuracy: number, timestamp: number };
      const deviceId = typedRow.deviceId;
      const parsed = RawGpsPositionSchema.safeParse({
        device: deviceId,
        geo: [typedRow.geoLon, typedRow.geoLat],
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

    this.groups = this.loadGroupsFromDB();
    this.rebuildGroupDerivedFields();
    for (const group of this.groups) {
      this.refreshGroupFromMembers(group.id);
    }

    vlog(`[ServerState] Restored ${posRows.length} trailing positions. ${Object.keys(this.engines).length} engines ready.`);
  }

  handleDevices(devices: TraccarDevice[]) {
    const isFirst = Object.keys(this.rawTraccarDevices).length === 0;

    for (const d of devices) {
      if (!d.id) continue;
      this.rawTraccarDevices[d.id] = d;
    }

    const deviceIds = Object.keys(this.rawTraccarDevices).map(Number);
    const now = Date.now();
    const stmt = db.prepare(`INSERT OR IGNORE INTO device_metadata (deviceId, emoji, color, motionProfile, updatedAt) VALUES (?, NULL, NULL, NULL, ?)`);
    db.transaction(() => {
      for (const deviceId of deviceIds) {
        stmt.run(deviceId, now);
      }
    })();
    this.deviceMetadataById = this.loadDeviceMetadata(deviceIds);

    // Replace materialized devices to avoid stale data from users/devices no longer visible.
    this.devices = this.materializeAppDevices();
    this.reloadGroupsFromDB(false);

    if (isFirst && this.positionsAll.length > 0) {
      vlog(`[ServerState] Initial catch-up for ${this.positionsAll.length} positions...`);
      this.rebuildPositionIndexFromAllPositions();
    }

    vlog(`[ServerState] Handled ${devices.length} updates. Total: ${Object.keys(this.devices).length}`);
  }

  getGroupMetadata(groupId: number): DeviceMetadata | null {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return null;

    return db.query(`SELECT name, emoji, color, motionProfile FROM groups WHERE id = ?`).get(dbGroupId) as DeviceMetadata | null;
  }

  getGroupMembers(groupId: number): number[] {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return [];

    const rows = db.query(`SELECT deviceId FROM group_members WHERE groupId = ? ORDER BY deviceId ASC`).all(dbGroupId) as { deviceId: number }[];
    return rows.map(row => row.deviceId);
  }

  createGroup(name: string, emoji: string, memberDeviceIds: number[], owner: string): AppDevice | null {
    const createdAt = Date.now();
    let groupDbId = 0;

    db.transaction(() => {
      const insertGroupResult = db.query(`INSERT INTO groups (owner, name, emoji, color, motionProfile, createdAt) VALUES (?, ?, ?, NULL, NULL, ?)`)
        .run(owner, name, emoji, createdAt);
      groupDbId = Number(insertGroupResult.lastInsertRowid);

      if (memberDeviceIds.length <= 0) return;
      const stmt = db.prepare(`INSERT INTO group_members (groupId, deviceId) VALUES (?, ?)`);
      for (const deviceId of memberDeviceIds) {
        stmt.run(groupDbId, deviceId);
      }
    })();

    this.reloadGroupsFromDB(true);

    return this.groups.find(group => group.id === -groupDbId) ?? null;
  }

  deleteGroup(groupId: number): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;

    const deleteResult = db.query(`DELETE FROM groups WHERE id = ?`).run(dbGroupId);
    if (deleteResult.changes === 0) return false;

    this.clearGroupRuntime(groupId);
    this.reloadGroupsFromDB(true);
    return true;
  }

  updateGroupMetadata(groupId: number, updates: DeviceMetadata): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;

    const result = db.query(`UPDATE groups SET name = ?, emoji = ?, color = ?, motionProfile = ? WHERE id = ?`)
      .run(updates.name, updates.emoji, updates.color, updates.motionProfile, dbGroupId);
    if (result.changes === 0) return false;

    this.clearGroupRuntime(groupId);
    this.reloadGroupsFromDB(false);
    return true;
  }

  addDeviceToGroup(groupId: number, deviceId: number): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;
    const groupExists = db.query(`SELECT 1 as exists FROM groups WHERE id = ?`).get(dbGroupId) as { exists: number } | null;
    if (!groupExists) return false;

    db.query(`INSERT INTO group_members (groupId, deviceId) VALUES (?, ?)`).run(dbGroupId, deviceId);

    this.clearGroupRuntime(groupId);
    this.reloadGroupsFromDB(true);
    return true;
  }

  removeDeviceFromGroup(groupId: number, deviceId: number): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;
    const groupExists = db.query(`SELECT 1 as exists FROM groups WHERE id = ?`).get(dbGroupId) as { exists: number } | null;
    if (!groupExists) return false;

    db.query(`DELETE FROM group_members WHERE groupId = ? AND deviceId = ?`).run(dbGroupId, deviceId);

    this.clearGroupRuntime(groupId);
    this.reloadGroupsFromDB(true);
    return true;
  }

  upsertDeviceMetadata(deviceId: number, updates: DeviceMetadata) {
    if (this.devices[deviceId] === undefined) return;

    const now = Date.now();
    db.query(`
      INSERT INTO device_metadata (deviceId, emoji, color, motionProfile, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        emoji = excluded.emoji,
        color = excluded.color,
        motionProfile = excluded.motionProfile,
        updatedAt = excluded.updatedAt
    `).run(deviceId, updates.emoji, updates.color, updates.motionProfile, now);

    this.deviceMetadataById[deviceId] = updates;
    this.devices = this.materializeAppDevices();
    this.reloadGroupsFromDB(false);
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
        const stmt = db.prepare(`INSERT INTO position_events (deviceId, geoLon, geoLat, accuracy, timestamp) VALUES (?, ?, ?, ?, ?)`);
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

    if (Math.random() < 0.05) db.run("DELETE FROM position_events WHERE timestamp < ?", [cutoff]);

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
        db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ? AND timestamp > ?`, [id, cp.timestamp]);
      } else {
        this.engines[id] = new Engine();
        this.engineCheckpoints[id] = [];
        db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ?`, [id]);
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
        if (oldest) db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ? AND timestamp = ?`, [id, oldest.timestamp]);
      }
    }

    if (pendingCheckpointWrites.length) {
      const stmt = db.prepare(`INSERT OR REPLACE INTO engine_checkpoints (deviceId, timestamp, snapshotJson) VALUES (?, ?, ?)`);
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

  /**
   * Unified projection for config updates: returns devices and groups visible to a user.
   * Used by both initial_state and config_update to ensure consistent entity visibility.
   */
  getConfigProjection(allowedDeviceIds: Set<number>) {
    const devices: Record<number, AppDevice> = {};

    // 1. Include all allowed devices
    for (const [id, dev] of numericEntries(this.devices)) {
      if (allowedDeviceIds.has(id)) devices[id] = dev;
    }

    // 2. Filter groups: include if user has direct permission or any member device access
    const allowedGroups = this.groups.filter(g =>
      allowedDeviceIds.has(g.id) ||
      (g.memberDeviceIds?.some(mid => allowedDeviceIds.has(mid)) ?? false)
    );

    // 3. Include all member devices from allowed groups
    for (const mid of allowedGroups.flatMap(g => g.memberDeviceIds ?? [])) {
      if (this.devices[mid]) devices[mid] = this.devices[mid];
    }

    return {
      devices,
      groups: allowedGroups
    };
  }
}
