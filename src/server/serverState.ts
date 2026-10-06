import { buildEngineSnapshotsFromByDevice } from "./serverUtils";
import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { db } from "./db";
import { Engine } from "@/engine/engine";
import { EngineStateSchema, EngineEventSchema, MotionProfileNameSchema } from "@/types";
import { numericEntries } from "@/util/record";
import { rgbToHex, colorForDevice } from "@/util/color";
import { toWebMercator } from "@/util/webMercator";
import { vlog } from "@/util/logger";
import type { DevicePoint, MotionProfileName, EngineEvent, AppDevice, TraccarDevice, EngineState, Vec2, RawGpsPosition, DeviceMetadata } from "@/types";

function dedupeKey(p: { device: number; timestamp: number; geo: Vec2 }) {
  return `${p.device}:${p.timestamp}:${p.geo[1]}:${p.geo[0]}`;
}

function eventFingerprint(ev: EngineEvent): string {
  return `${ev.type}|${ev.start}|${ev.end}`;
}

const PRUNE_INTERVAL_MS = 60_000;

/**
 * How much raw history stays resident in RAM for dedupe and incremental ingest.
 * Everything older lives in SQLite and is read back on demand, so resident memory
 * scales with the hot window rather than with the retention window.
 */
const HOT_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Minimum spacing between full-history rebuild requests for one entity. */
const HISTORY_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

export class ServerState {
  devices: Record<number, AppDevice> = {};
  groups: AppDevice[] = [];
  deviceToGroupsMap: Record<number, number[]> = {};
  groupIds = new Set<number>();
  engines: Record<number, Engine> = {};
  engineCheckpoints: Record<number, { timestamp: number; snapshot: EngineState }[]> = {};
  // windowedKeys tracks what is already reflected in the resident position index.
  // consumedKeys tracks what the engine has already been fed. These diverge for an
  // entity whose batch is deferred waiting on history: its positions are windowed but
  // deliberately not consumed, so they stay replayable.
  windowedKeys = new Set<string>();
  consumedKeys = new Set<string>();
  deviceMetadataById: Record<number, DeviceMetadata> = {};
  private rawTraccarDevices: Record<number, TraccarDevice> = {};

  activePointsByDevice: Record<number, DevicePoint[]> = {};
  eventsByDevice: Record<number, EngineEvent[]> = {};
  positionsAll: RawGpsPosition[] = [];
  private allPosById: Record<number, RawGpsPosition[]> = {};
  private historyRequests = new Map<number, { from: number; to: number }>();
  private lastHistoryRequestAt = new Map<number, number>();
  private historyMs: number;
  private eventRows: Record<number, Map<string, number>> = {};
  private lastPruneAt = 0;
  private lastEnginePruneAt = 0;
  private profileCache: Record<number, MotionProfileName> | null = null;

  private currentProfiles(): Record<number, MotionProfileName> {
    if (this.profileCache) return this.profileCache;
    const profiles: Record<number, MotionProfileName> = {};
    for (const [id, device] of numericEntries(this.devices)) {
      profiles[id] = device.effectiveMotionProfile;
    }
    for (const group of this.groups) {
      profiles[group.id] = group.motionProfile ?? ((group.memberDeviceIds?.some(mId => profiles[mId] === "car")) ? "car" : "person");
    }
    this.profileCache = profiles;
    return profiles;
  }

  private invalidateProfileCache() {
    this.profileCache = null;
  }

  /**
   * Age out resident positions and their dedupe keys on a timer. This scan is
   * O(resident positions), so running it per batch made every ingest cost scale
   * with the whole resident window. Traccar holds the older history.
   */
  private prunePositions() {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;

    const cutoff = now - HOT_WINDOW_MS;
    while (this.positionsAll.length > 0 && this.positionsAll[0]!.timestamp <= cutoff) {
      const p = this.positionsAll.shift();
      if (!p) break;
      const k = dedupeKey(p);
      this.consumedKeys.delete(k);
      this.windowedKeys.delete(k);
    }

    for (const [id, list] of numericEntries(this.allPosById)) {
      const split = list.findIndex(p => p.timestamp > cutoff);
      if (split === -1) delete this.allPosById[id];
      else if (split > 0) this.allPosById[id] = list.slice(split);
    }
  }

  /**
   * Age out finished events on a timer rather than on every position batch.
   * Pruning is O(history), so running it per batch made every ingest cost scale
   * with total retained history rather than with the batch itself.
   */
  private pruneEngines() {
    const now = Date.now();
    if (now - this.lastEnginePruneAt < PRUNE_INTERVAL_MS) return;
    this.lastEnginePruneAt = now;
    const cutoff = now - this.historyMs - (24 * 60 * 60 * 1000);
    for (const engine of Object.values(this.engines)) {
      engine.pruneHistory(cutoff);
    }
  }

  /**
   * Writes a checkpoint for every engine that has advanced past its newest one.
   *
   * Boot only has to replay from the newest checkpoint, so checkpoints are the whole
   * reason a restart is cheap. `force` ignores the interval gate, which is what makes
   * the last few minutes of state survive a shutdown instead of being recomputed from
   * Traccar on the next start.
   */
  private checkpointEngines(force: boolean): void {
    const pending: { id: number, cp: { timestamp: number, snapshot: EngineState } }[] = [];

    for (const [id, engine] of numericEntries(this.engines)) {
      if (!engine.lastTimestamp) continue;
      const checkpoints = this.engineCheckpoints[id] ?? [];
      const lastCp = checkpoints[checkpoints.length - 1];
      if (lastCp && lastCp.timestamp >= engine.lastTimestamp) continue;
      if (!force && lastCp && (engine.lastTimestamp - lastCp.timestamp) <= CHECKPOINT_INTERVAL_MS) continue;
      const cp = { timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() };
      checkpoints.push(cp);
      this.engineCheckpoints[id] = checkpoints;
      pending.push({ id, cp });

      if (checkpoints.length > MAX_CHECKPOINTS) {
        const oldest = checkpoints.shift();
        if (oldest) db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ? AND timestamp = ?`, [id, oldest.timestamp]);
      }
    }

    if (pending.length === 0) return;
    const stmt = db.prepare(`INSERT OR REPLACE INTO engine_checkpoints (deviceId, timestamp, snapshotJson) VALUES (?, ?, ?)`);
    db.transaction(() => pending.forEach(item => stmt.run(item.id, item.cp.timestamp, JSON.stringify(item.cp.snapshot))))();
  }

  /**
   * Hands the engines and the database to disk before the process exits.
   *
   * Events are normally synced right after the batch that produced them, but doing it
   * again here costs nothing when there is nothing pending and guarantees the events
   * table matches the engines at the moment of exit.
   */
  flush(): void {
    for (const [id, engine] of numericEntries(this.engines)) {
      if (engine.consumeChanged()) this.syncEventsForEntity(id, engine);
    }
    this.checkpointEngines(true);
  }

  private loadEventRows() {
    this.eventRows = {};
    const rows = db.query(`SELECT id, entityId, type, start, end FROM events`).all() as
      { id: number, entityId: number, type: string, start: number, end: number }[];
    for (const row of rows) {
      const map = this.eventRows[row.entityId] ??= new Map();
      map.set(`${row.type}|${row.start}|${row.end}`, row.id);
    }
  }

  loadClosedEvents(entityId: number, endAt: number = Number.MAX_SAFE_INTEGER): EngineEvent[] {
    const rows = db.query(
      `SELECT eventJson FROM events WHERE entityId = ? AND end <= ? ORDER BY start ASC`
    ).all(entityId, endAt) as { eventJson: string }[];

    const out: EngineEvent[] = [];
    for (const row of rows) {
      const parsed = EngineEventSchema.safeParse(JSON.parse(row.eventJson));
      if (parsed.success) out.push(parsed.data);
      else console.error(`[ServerState] Discarding unreadable event row for entity ${entityId}`, parsed.error);
    }
    return out;
  }

  private insertEventRow(entityId: number, ev: EngineEvent): number {
    const result = db.query(
      `INSERT INTO events (entityId, type, start, end, eventJson) VALUES (?, ?, ?, ?, ?)`
    ).run(entityId, ev.type, ev.start, ev.end, JSON.stringify(ev));
    return Number(result.lastInsertRowid);
  }

  private deleteEventRows(entityId: number, rowIds: number[]) {
    if (rowIds.length === 0) return;
    const placeholders = rowIds.map(() => "?").join(",");
    db.query(`DELETE FROM events WHERE entityId = ? AND id IN (${placeholders})`).run(entityId, ...rowIds);
  }

  private syncEventsForEntity(entityId: number, engine: Engine) {
    const rows = this.eventRows[entityId] ?? new Map<string, number>();
    const desired = new Set<string>();
    const toInsert: EngineEvent[] = [];

    for (const ev of engine.closed) {
      const fp = eventFingerprint(ev);
      desired.add(fp);
      if (!rows.has(fp)) toInsert.push(ev);
    }

    const staleRowIds: number[] = [];
    for (const [fp, rowId] of rows) {
      if (!desired.has(fp)) staleRowIds.push(rowId);
    }

    if (staleRowIds.length === 0 && toInsert.length === 0) return;

    db.transaction(() => {
      this.deleteEventRows(entityId, staleRowIds);
      for (const ev of toInsert) {
        const fp = eventFingerprint(ev);
        rows.set(fp, this.insertEventRow(entityId, ev));
      }
    })();

    if (rows.size === 0) delete this.eventRows[entityId];
    else this.eventRows[entityId] = rows;
  }

  static toDbGroupId(appGroupId: number) {
    if (appGroupId >= 0) return null;
    return -appGroupId;
  }

  /** The raw device ids a derived entity is built from. A group is its members. */
  private sourceDeviceIds(id: number): number[] {
    if (!this.groupIds.has(id)) return [id];
    return Array.from(new Set(this.groups.find(group => group.id === id)?.memberDeviceIds ?? []));
  }

  /**
   * Resident positions for an entity between two timestamps. A device that was
   * simply not reporting leaves a gap that the engine already tolerates, so an
   * empty result is normal and callers must not read it as an error.
   */
  private positionsBetween(id: number, from: number, until: number): RawGpsPosition[] {
    const list = this.allPosById[id];
    if (!list || list.length === 0) return [];
    const start = this.firstAfterTimestamp(list, from);
    const out: RawGpsPosition[] = [];
    for (let i = start; i < list.length; i++) {
      const p = list[i];
      if (!p || p.timestamp >= until) break;
      out.push(p);
    }
    return out;
  }

  /** True when the hot window reaches back at or before `timestamp` for this entity. */
  private windowCovers(id: number, timestamp: number): boolean {
    const list = this.allPosById[id];
    return !!list && list.length > 0 && list[0]!.timestamp <= timestamp;
  }

  private joinSourcePositions(deviceIds: number[], from: number, until: number): RawGpsPosition[] {
    const out: RawGpsPosition[] = [];
    for (const deviceId of deviceIds) out.push(...this.positionsBetween(deviceId, from, until));
    if (deviceIds.length > 1) out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
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

  /** Queue a range that must be fetched from Traccar and drained by the server loop. */
  requestHistory(deviceIds: number[], from: number, to: number) {
    for (const deviceId of deviceIds) {
      const pending = this.historyRequests.get(deviceId);
      this.lastHistoryRequestAt.set(deviceId, Date.now());
      if (!pending || from < pending.from) {
        this.historyRequests.set(deviceId, { from, to: Math.max(to, pending?.to ?? 0) });
      }
    }
  }

  drainHistoryRequests(): { deviceId: number; from: number; to: number }[] {
    const out = Array.from(this.historyRequests, ([deviceId, range]) => ({ deviceId, ...range }));
    this.historyRequests.clear();
    return out;
  }

  private clearGroupRuntime(groupId: number) {
    delete this.activePointsByDevice[groupId];
    delete this.eventsByDevice[groupId];
    delete this.engines[groupId];
    delete this.engineCheckpoints[groupId];
    delete this.allPosById[groupId];
    delete this.eventRows[groupId];
    db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ?`, [groupId]);
    db.run(`DELETE FROM events WHERE entityId = ?`, [groupId]);
  }

  /**
   * A group checkpoint stays valid while its membership is unchanged, since the
   * merged member stream it was derived from is unchanged too.
   */
  private groupCheckpointMatches(groupId: number, memberDeviceIds: number[]): boolean {
    const latest = this.engineCheckpoints[groupId]?.at(-1);
    if (!latest) return false;
    const engine = this.engines[groupId];
    if (!engine || !latest.snapshot.lastTimestamp) return false;

    const previous = latest.snapshot.members;
    if (!previous) return false;
    if (previous.length !== memberDeviceIds.length) return false;
    return previous.every((id, i) => id === memberDeviceIds[i]);
  }

  private rebuildGroupDerivedFields() {
    this.invalidateProfileCache();
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

  private refreshGroupFromMembers(groupId: number, force: boolean = true) {
    const group = this.groups.find(g => g.id === groupId);
    const memberDeviceIds = Array.from(new Set(group?.memberDeviceIds ?? [])).sort((a, b) => a - b);

    if (!group || memberDeviceIds.length === 0) {
      this.clearGroupRuntime(groupId);
      return;
    }

    if (!force && this.groupCheckpointMatches(groupId, memberDeviceIds)) return;

    // Group events are derived from member positions, which live in Traccar now. Clear
    // the runtime and queue the members instead of deriving here: the normal ingest
    // path rebuilds the group, because a group's batches are built from member
    // positions anyway. While the history is in flight the group has no events, which
    // is visible but correct.
    this.clearGroupRuntime(groupId);
    this.requestHistory(memberDeviceIds, Date.now() - this.historyMs, Date.now());
  }

  private reloadGroupsFromDB(rebuildHistory: boolean) {
    const previousGroupIds = new Set(this.groups.map(group => group.id));
    const previousMemberships = new Map(this.groups.map(g => [g.id, g.memberDeviceIds ?? []]));

    this.groups = this.loadGroupsFromDB();
    this.rebuildGroupDerivedFields();

    // Clear runtime state for deleted groups
    for (const oldId of previousGroupIds) {
      if (!this.groupIds.has(oldId)) this.clearGroupRuntime(oldId);
    }

    // Detect groups with changed membership
    const hasAnyMembershipChange = this.groups.some(group => {
      const oldMembers = previousMemberships.get(group.id) ?? [];
      const newMembers = group.memberDeviceIds ?? [];
      if (oldMembers.length !== newMembers.length) return true;
      const oldSet = new Set(oldMembers);
      return newMembers.some(m => !oldSet.has(m));
    });

    // Rebuild history if explicitly requested OR if membership changed
    if (rebuildHistory || hasAnyMembershipChange) {
      for (const group of this.groups) {
        this.refreshGroupFromMembers(group.id);
      }
    }
  }

  loadDeviceMetadata(deviceIds: number[]) {
    const out: Record<number, DeviceMetadata> = {};
    if (deviceIds.length === 0) return out;

    const placeholders = deviceIds.map(() => "?").join(",");
    const rows = db.query(`SELECT deviceId, icon, color, motionProfile FROM device_metadata WHERE deviceId IN (${placeholders})`).all(...deviceIds) as {
      deviceId: number;
      icon: string | null;
      color: string | null;
      motionProfile: MotionProfileName | null;
    }[];

    for (const row of rows) {
      out[row.deviceId] = {
        name: this.rawTraccarDevices[row.deviceId]?.name ?? `Device ${row.deviceId}`,
        icon: row.icon,
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
      // Every device Traccar reports is listed, however long ago it last reported.
      // History retention below governs how much history the engine keeps, and using it
      // to decide visibility hid devices that had merely been offline, which is exactly
      // when knowing the last seen time matters most.
      const lastSeen = raw.lastUpdate ? Date.parse(raw.lastUpdate) : null;

      const metadata = this.deviceMetadataById[id] ?? {
        icon: null,
        color: null,
        motionProfile: null,
      };

      const effectiveMotionProfile = metadata.motionProfile ?? "person";
      result[id] = {
        id,
        name: raw.name,
        icon: metadata.icon ?? raw.name.trim().charAt(0),
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
    const groupRows = db.query(`SELECT id, name, icon, color, motionProfile FROM groups ORDER BY id ASC`).all() as {
      id: number;
      name: string;
      icon: string | null;
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
        icon: row.icon ?? row.name.trim().charAt(0),
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

    this.loadEventRows();

    const legacyClosed = new Map<number, EngineEvent[]>();

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
          this.engines[deviceId]?.setMembers(snapshot.members);
          if (snapshot.closed.length > 0) {
            legacyClosed.set(deviceId, snapshot.closed as EngineEvent[]);
          }
        } catch (err) {
          console.error("Failed to parse/validate snapshot for device", deviceId, err);
        }
      });

    // 1b. Hydrate finished events. The events table is authoritative; checkpoints
    // written before that table existed still carry their own closed list, so
    // fall back to those and sync them forward once.
    for (const [entityId, engine] of numericEntries(this.engines)) {
      let closed = this.loadClosedEvents(entityId);
      if (closed.length === 0) {
        closed = legacyClosed.get(entityId) ?? [];
      }
      engine.setClosed(closed);
      this.syncEventsForEntity(entityId, engine);
    }

    vlog(`[ServerState] Restoring recent positions...`);
    // 2. The hot window starts empty. Traccar is the source for history, and the
    // server loop fetches anything the engine is missing.
    vlog(`[ServerState] Restored 0 hot positions. ${Object.keys(this.engines).length} engines ready.`);

    this.groups = this.loadGroupsFromDB();
    this.rebuildGroupDerivedFields();
    for (const group of this.groups) {
      this.refreshGroupFromMembers(group.id, false);
    }

    this.hydrateTimeline();
  }

  /**
   * Populate the wire-facing timeline and active points from current engine
   * state, without processing any measurements. Runs once at boot so clients
   * receive history on `initial_state` instead of waiting for the first fix.
   */
  private hydrateTimeline() {
    const profiles: Record<number, MotionProfileName> = {};
    for (const [id, device] of numericEntries(this.devices)) {
      profiles[id] = device.effectiveMotionProfile;
    }
    for (const group of this.groups) {
      profiles[group.id] = group.effectiveMotionProfile;
    }

    const result = buildEngineSnapshotsFromByDevice({}, this.engines, profiles, Object.keys(this.engines).map(Number));
    Object.assign(this.activePointsByDevice, result.positionsByDevice);
    Object.assign(this.eventsByDevice, result.eventsByDevice);

    for (const id of Object.keys(this.eventsByDevice)) {
      this.eventsByDevice[Number(id)]?.sort((a, b) => b.start - a.start);
    }
  }

  handleDevices(devices: TraccarDevice[]) {
    for (const d of devices) {
      if (!d.id) continue;
      this.rawTraccarDevices[d.id] = d;
    }

    const deviceIds = Object.keys(this.rawTraccarDevices).map(Number);
    const now = Date.now();
    const stmt = db.prepare(`INSERT OR IGNORE INTO device_metadata (deviceId, icon, color, motionProfile, updatedAt) VALUES (?, NULL, NULL, NULL, ?)`);
    db.transaction(() => {
      for (const deviceId of deviceIds) {
        stmt.run(deviceId, now);
      }
    })();
    this.deviceMetadataById = this.loadDeviceMetadata(deviceIds);

    // Replace materialized devices to avoid stale data from users/devices no longer visible.
    this.devices = this.materializeAppDevices();
    this.invalidateProfileCache();
    this.reloadGroupsFromDB(false);

    vlog(`[ServerState] Handled ${devices.length} updates. Total: ${Object.keys(this.devices).length}`);
  }

  getGroupMetadata(groupId: number): DeviceMetadata | null {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return null;

    return db.query(`SELECT name, icon, color, motionProfile FROM groups WHERE id = ?`).get(dbGroupId) as DeviceMetadata | null;
  }

  getGroupMembers(groupId: number): number[] {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return [];

    const rows = db.query(`SELECT deviceId FROM group_members WHERE groupId = ? ORDER BY deviceId ASC`).all(dbGroupId) as { deviceId: number }[];
    return rows.map(row => row.deviceId);
  }

  createGroup(name: string, icon: string, memberDeviceIds: number[], owner: string): AppDevice | null {
    const createdAt = Date.now();
    let groupDbId = 0;

    db.transaction(() => {
      const insertGroupResult = db.query(`INSERT INTO groups (owner, name, icon, color, motionProfile, createdAt) VALUES (?, ?, ?, NULL, NULL, ?)`)
        .run(owner, name, icon, createdAt);
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

    db.query(`DELETE FROM group_members WHERE groupId = ?`).run(dbGroupId);
    const deleteResult = db.query(`DELETE FROM groups WHERE id = ?`).run(dbGroupId);
    if (deleteResult.changes === 0) return false;

    this.clearGroupRuntime(groupId);
    this.reloadGroupsFromDB(true);
    return true;
  }

  updateGroupMetadata(groupId: number, updates: DeviceMetadata): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;

    const previousProfile = this.groups.find(group => group.id === groupId)?.motionProfile ?? null;

    const result = db.query(`UPDATE groups SET name = ?, icon = ?, color = ?, motionProfile = ? WHERE id = ?`)
      .run(updates.name, updates.icon, updates.color, updates.motionProfile, dbGroupId);
    if (result.changes === 0) return false;

    this.reloadGroupsFromDB(false);
    // A rename, icon or colour change does not alter what the engine derived from the
    // member stream, so the group's events stay valid. Only a profile change does.
    if ((updates.motionProfile ?? null) !== previousProfile) {
      this.refreshGroupFromMembers(groupId);
    }
    return true;
  }

  addDeviceToGroup(groupId: number, deviceId: number): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;
    const groupExists = db.query(`SELECT 1 AS found FROM groups WHERE id = ?`).get(dbGroupId) as { found: number } | null;
    if (!groupExists) return false;

    db.query(`INSERT INTO group_members (groupId, deviceId) VALUES (?, ?)`).run(dbGroupId, deviceId);

    this.clearGroupRuntime(groupId);
    this.reloadGroupsFromDB(true);
    return true;
  }

  removeDeviceFromGroup(groupId: number, deviceId: number): boolean {
    const dbGroupId = ServerState.toDbGroupId(groupId);
    if (dbGroupId === null) return false;
    const groupExists = db.query(`SELECT 1 AS found FROM groups WHERE id = ?`).get(dbGroupId) as { found: number } | null;
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
      INSERT INTO device_metadata (deviceId, icon, color, motionProfile, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        icon = excluded.icon,
        color = excluded.color,
        motionProfile = excluded.motionProfile,
        updatedAt = excluded.updatedAt
    `).run(deviceId, updates.icon, updates.color, updates.motionProfile, now);

    this.deviceMetadataById[deviceId] = updates;
    this.devices = this.materializeAppDevices();
    this.invalidateProfileCache();
    this.reloadGroupsFromDB(false);
  }

  handlePositions(pts: RawGpsPosition[]): boolean {
    if (pts.length === 0) return false;

    // Dedupe memory is bounded to the hot window. Older positions are not retained;
    // if Traccar redelivers one it is simply reprocessed.
    const hotCutoff = Date.now() - HOT_WINDOW_MS;
    const newPts = pts.filter(p => {
      if (p.timestamp <= hotCutoff) return true;
      const k = dedupeKey(p);
      if (this.windowedKeys.has(k)) return false;
      this.windowedKeys.add(k);
      return true;
    });

    if (newPts.length > 0) {
      // Ingest is normally already in timestamp order, so only re-sort when a batch
      // actually arrives out of order. The index carries an entry per raw device and
      // per group that device belongs to.
      let needsSort = false;
      let lastTs = this.positionsAll.length > 0 ? this.positionsAll[this.positionsAll.length - 1]!.timestamp : -Infinity;
      for (const p of newPts) {
        if (p.timestamp <= hotCutoff) continue;
        if (p.timestamp < lastTs) needsSort = true;
        if (p.timestamp > lastTs) lastTs = p.timestamp;
        this.positionsAll.push(p);

        for (const id of [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])]) {
          const list = this.allPosById[id] ??= [];
          const previous = list[list.length - 1];
          list.push(p);
          if (previous && previous.timestamp > p.timestamp) list.sort((a, b) => a.timestamp - b.timestamp);
        }
      }
      if (needsSort) this.positionsAll.sort((a, b) => a.timestamp - b.timestamp);
    }

    const cutoff = Date.now() - this.historyMs;
    this.prunePositions();

    const profiles = this.currentProfiles();

    const posById: Record<number, RawGpsPosition[]> = {};
    const seenThisCall = new Set<string>();
    for (const p of pts) {
      if (p.timestamp <= cutoff) continue;
      const key = dedupeKey(p);
      if (this.consumedKeys.has(key) || seenThisCall.has(key)) continue;
      seenThisCall.add(key);
      for (const id of [p.device, ...(this.deviceToGroupsMap[p.device] ?? [])]) {
        posById[id] ??= [];
        posById[id].push(p);
      }
    }

    // Fill the gap between the engine watermark and this batch from the hot window.
    // An empty gap just means the device was not reporting, which the engine accepts.
    for (const [id, batch] of numericEntries(posById)) {
      const engine = this.engines[id];
      if (!engine) continue;
      const trailing = this.joinSourcePositions(this.sourceDeviceIds(id), engine.lastTimestamp ?? 0, batch[0]?.timestamp ?? Number.MAX_SAFE_INTEGER);
      if (trailing.length === 0) continue;

      posById[id] = [...batch, ...trailing].sort((a, b) => a.timestamp - b.timestamp);
    }
    // A group's batch interleaves several member devices, so it must be ordered
    // before the engine sees it. Feeding it out of order produces different
    // events than the same data on the rebuild path.
    for (const id of Object.keys(posById)) {
      const list = posById[Number(id)];
      if (list && list.length > 1) list.sort((a, b) => a.timestamp - b.timestamp);
    }

    if (Object.keys(posById).length === 0) return false;

    // Replay for out-of-order data
    const awaitingHistory = new Set<number>();
    for (const [id, newPos] of numericEntries(posById)) {
      const engine = this.engines[id];
      const first = newPos[0];
      if (!engine || !first || first.timestamp >= (engine.lastTimestamp ?? -1)) continue;

      const checkpoints = this.engineCheckpoints[id] ?? [];
      const cpIndex = checkpoints.findLastIndex(c => c.timestamp < first.timestamp);
      const cp = cpIndex >= 0 ? checkpoints[cpIndex] : null;

      if (cp) {
        // Rewinding means replaying every position from the checkpoint forward, so
        // the window has to reach back that far. If it does not, the range has to
        // come from Traccar and this entity waits for the next pass.
        if (!this.windowCovers(id, cp.timestamp)) {
          this.requestHistory(this.sourceDeviceIds(id), cp.timestamp, Date.now());
          awaitingHistory.add(id);
          continue;
        }
        engine.restoreSnapshot(cp.snapshot);
        engine.setMembers(cp.snapshot.members);
        // Restore only the events that had already closed at snapshot time. The
        // checkpoint timestamp is the engine watermark, which is later than that
        // boundary, so using it would also load events the restored draft is about to
        // re-derive.
        engine.setClosed(this.loadClosedEvents(id, cp.snapshot.closedUpTo ?? cp.timestamp));
        this.engineCheckpoints[id] = checkpoints.slice(0, cpIndex + 1);
        db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ? AND timestamp > ?`, [id, cp.timestamp]);
        // The engine was rolled back, so every position from the checkpoint forward has
        // to be replayed, including ones a previous call already fed. Filtering those
        // out would leave the engine missing everything between the checkpoint and now.
        posById[id] = this.joinSourcePositions(this.sourceDeviceIds(id), cp.timestamp, Number.MAX_SAFE_INTEGER);
      } else if (Date.now() - (this.lastHistoryRequestAt.get(id) ?? 0) < HISTORY_REQUEST_COOLDOWN_MS) {
        // A rebuild was requested recently. Clearing again would throw away the replay
        // in flight, so leave the entity alone until that fetch lands.
        continue;
      } else {
        // This point predates every checkpoint, so the engine cannot be rewound far
        // enough to accept it incrementally. Drop the engine and ask Traccar for the
        // retained range; the next pass rebuilds from every raw position.
        this.engines[id] = new Engine();
        this.engineCheckpoints[id] = [];
        delete this.allPosById[id];
        db.run(`DELETE FROM engine_checkpoints WHERE deviceId = ?`, [id]);
        vlog(`[ServerState] Entity ${id}: point at ${new Date(first.timestamp).toISOString()} predates all checkpoints, requesting retained history`);
        this.requestHistory(this.sourceDeviceIds(id), cutoff, Date.now());
        awaitingHistory.add(id);
        continue;
      }
    }

    for (const id of awaitingHistory) delete posById[id];

    // Marking happens only once every entity that will actually be fed is known. Doing
    // it earlier swallowed a batch that had to wait for history, because that batch's
    // keys were already spent by the time the fetched range arrived. Positions older
    // than the hot window stay unmarked so dedupe memory remains bounded.
    for (const [, arr] of numericEntries(posById)) {
      for (const p of arr) {
        if (p.timestamp > hotCutoff) this.consumedKeys.add(dedupeKey(p));
      }
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
    const result = buildEngineSnapshotsFromByDevice(rawByDevice, this.engines, motionProfiles, Object.keys(rawByDevice).map(Number));

    // A group checkpoint records its member list, so stamp the current members on
    // every group engine we touch. Without this a restart can never match, and the
    // group would be re-derived from Traccar on every boot.
    for (const id of Object.keys(rawByDevice).map(Number)) {
      if (this.groupIds.has(id)) this.engines[id]?.setMembers(this.sourceDeviceIds(id));
    }

    this.pruneEngines();

    for (const [id, engine] of numericEntries(this.engines)) {
      if (engine.consumeChanged()) this.syncEventsForEntity(id, engine);
    }

    this.checkpointEngines(false);

    Object.assign(this.activePointsByDevice, result.positionsByDevice);
    Object.assign(this.eventsByDevice, result.eventsByDevice);
    for (const id in this.eventsByDevice) {
      this.eventsByDevice[id]?.sort((a, b) => b.start - a.start);
    }

    vlog(`[ServerState] handlePositions: ${pts.length} pts across ${Object.keys(posById).length} entities`);
    return true;
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
