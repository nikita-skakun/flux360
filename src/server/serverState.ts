import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINTS } from "@/engine/motionDetector";
import { db } from "./db";
import { dedupeKey, buildEngineSnapshotsFromByDevice } from "./serverUtils";
import { Engine } from "@/engine/engine";
import { EngineStateSchema, NormalizedPositionSchema } from "@/types";
import { rgbToHex, colorForDevice } from "@/util/color";
import { toWebMercator } from "@/util/webMercator";
import { vlog } from "@/util/logger";
import { z } from "zod";
import type { NormalizedPosition, DevicePoint, MotionProfileName, EngineEvent, AppDevice, TraccarDevice, EngineState } from "@/types";

export class ServerState {
  devices: Record<number, AppDevice> = {};
  groups: AppDevice[] = [];
  deviceToGroupsMap = new Map<number, number[]>();
  groupIds = new Set<number>();
  engines = new Map<number, Engine>();
  engineCheckpoints = new Map<number, { timestamp: number; snapshot: EngineState }[]>();
  processedKeys = new Set<string>();
  backfilled = new Set<number>();
  private rawTraccarDevices = new Map<number, TraccarDevice>();

  activePointsByDevice: Record<number, DevicePoint[]> = {};
  eventsByDevice: Record<number, EngineEvent[]> = {};
  positionsAll: NormalizedPosition[] = [];
  private allPosById = new Map<number, NormalizedPosition[]>();
  private historyMs: number;

  constructor(public readonly historyDays: number) {
    this.historyMs = historyDays * 24 * 60 * 60 * 1000;
    vlog(`[ServerState] Restoring engine checkpoints...`);

    // 1. Restore Checkpoints
    (db.query(`SELECT device_id, timestamp, snapshot_json FROM engine_checkpoints ORDER BY timestamp ASC`).all() as unknown[])
      .forEach(row => {
        const typedRow = row as { device_id: number, timestamp: number, snapshot_json: string | object };
        if (!this.engineCheckpoints.has(typedRow.device_id)) {
          this.engineCheckpoints.set(typedRow.device_id, []);
          this.engines.set(typedRow.device_id, new Engine());
        }
        try {
          const rawSnapshot = typeof typedRow.snapshot_json === 'string' ? JSON.parse(typedRow.snapshot_json) : typedRow.snapshot_json;
          const snapshot = EngineStateSchema.parse(rawSnapshot);
          this.engineCheckpoints.get(typedRow.device_id)?.push({ timestamp: typedRow.timestamp, snapshot });
          this.engines.get(typedRow.device_id)?.restoreSnapshot(snapshot);
        } catch (err) {
          console.error("Failed to parse/validate snapshot for device", typedRow.device_id, err);
        }
      });

    vlog(`[ServerState] Restoring recent positions...`);
    // 2. Restore recent raw positions so `positionsAll` is populated
    const cutoff = Date.now() - this.historyMs;
    const posRows = db.query(`SELECT device_id, geo_lng, geo_lat, accuracy, timestamp FROM position_events WHERE timestamp > ? ORDER BY timestamp ASC`).all(cutoff) as unknown[];
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

        let list = this.allPosById.get(p.device);
        if (!list) this.allPosById.set(p.device, list = []);
        list.push(p);

        const engine = this.engines.get(p.device);
        if (engine?.lastTimestamp && p.timestamp <= engine.lastTimestamp) {
          this.processedKeys.add(dedupeKey(p));
        }
      } catch (err) {
        console.error("Failed to validate position from DB:", err);
      }
    }
    vlog(`[ServerState] Restored ${posRows.length} trailing positions. ${this.engines.size} engines ready.`);
  }

  handleDevices(devices: TraccarDevice[]) {
    const isFirst = this.rawTraccarDevices.size === 0;

    for (const d of devices) {
      if (d.id) this.rawTraccarDevices.set(d.id, d);
    }

    const processed = Array.from(this.rawTraccarDevices.values())
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

    this.devices = Object.fromEntries(processed.map(d => [d.id, d.base]));
    this.groups = processed.map(d => d.group).filter((g): g is AppDevice => g !== null);

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

    this.deviceToGroupsMap.clear();
    this.groupIds.clear();
    for (const group of this.groups) {
      this.groupIds.add(group.id);
      group.memberDeviceIds?.forEach(deviceId => {
        const list = this.deviceToGroupsMap.get(deviceId) ?? [];
        list.push(group.id);
        this.deviceToGroupsMap.set(deviceId, list);
      });
    }

    if (isFirst && this.positionsAll.length > 0) {
      vlog(`[ServerState] Initial catch-up for ${this.positionsAll.length} positions...`);
      this.allPosById.clear();
      for (const p of this.positionsAll) {
        const ids = [p.device, ...(this.deviceToGroupsMap.get(p.device) ?? [])];
        for (const id of ids) {
          let list = this.allPosById.get(id);
          if (!list) this.allPosById.set(id, list = []);
          list.push(p);
        }
      }
      this.handlePositions([]);
    }

    vlog(`[ServerState] Handled ${devices.length} updates. Total: ${Object.keys(this.devices).length}`);
  }

  handlePositions(pts: NormalizedPosition[]) {
    if (pts.length === 0) return null;

    // 1. Save to Database
    db.transaction(() => {
      const stmt = db.prepare(`INSERT INTO position_events (device_id, geo_lng, geo_lat, accuracy, timestamp) VALUES (?, ?, ?, ?, ?)`);
      for (const p of pts) {
        stmt.run(p.device, p.geo[0], p.geo[1], p.accuracy, p.timestamp);
      }
    })();

    // 2. Update memory index
    this.positionsAll.push(...pts);
    this.positionsAll.sort((a, b) => a.timestamp - b.timestamp);

    for (const p of pts) {
      const ids = [p.device, ...(this.deviceToGroupsMap.get(p.device) ?? [])];
      for (const id of ids) {
        let list = this.allPosById.get(id);
        if (!list) this.allPosById.set(id, list = []);
        list.push(p);
        list.sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    // 3. Prune old data
    const cutoff = Date.now() - this.historyMs;
    const splitIdx = this.positionsAll.findIndex(p => p.timestamp > cutoff);
    if (splitIdx > 0) {
      for (let i = 0; i < splitIdx; i++) {
        const p = this.positionsAll[i];
        if (p) this.processedKeys.delete(dedupeKey(p));
      }
      this.positionsAll = this.positionsAll.slice(splitIdx);
    }

    for (const [id, list] of this.allPosById) {
      const split = list.findIndex(p => p.timestamp > cutoff);
      if (split === -1) {
        this.allPosById.delete(id);
      } else if (split > 0) {
        this.allPosById.set(id, list.slice(split));
      }
    }

    if (Math.random() < 0.05) {
      db.run('DELETE FROM position_events WHERE timestamp < ?', [cutoff]);
    }

    // 4. Compute Engine State
    const profiles: Record<number, MotionProfileName> = Object.fromEntries(
      Object.entries(this.devices).map(([id, d]) => [Number(id), d.effectiveMotionProfile])
    );

    const posById = new Map<number, NormalizedPosition[]>();
    for (const p of pts) {
      const key = dedupeKey(p);
      if (!this.processedKeys.has(key)) {
        this.processedKeys.add(key);
        const ids = [p.device, ...(this.deviceToGroupsMap.get(p.device) ?? [])];
        for (const id of ids) {
          let list = posById.get(id);
          if (!list) posById.set(id, list = []);
          list.push(p);
        }
      }
    }

    // Bootstrap trailing points for touched IDs
    for (const id of posById.keys()) {
      const engine = this.engines.get(id);
      const lastTs = engine?.lastTimestamp ?? 0;
      const history = this.allPosById.get(id) ?? [];
      const batch = posById.get(id) ?? [];

      const trailing = history.filter(p => p.timestamp > lastTs && !batch.some(bp => dedupeKey(bp) === dedupeKey(p)));
      if (trailing.length) {
        const combined = [...batch, ...trailing].sort((a, b) => a.timestamp - b.timestamp);
        posById.set(id, combined);
        for (const p of trailing) this.processedKeys.add(dedupeKey(p));
      }
    }

    if (!posById.size) return null;

    // Replay for out-of-order data
    for (const [id, newPos] of posById) {
      const engine = this.engines.get(id);
      if (!engine?.lastTimestamp || !newPos[0] || newPos[0].timestamp >= engine.lastTimestamp) continue;

      const minTs = newPos[0].timestamp;
      const checkpoints = this.engineCheckpoints.get(id) ?? [];
      const cpIndex = checkpoints.findLastIndex(c => c.timestamp < minTs);
      const cp = cpIndex >= 0 ? checkpoints[cpIndex] : null;

      if (cp) {
        engine.restoreSnapshot(cp.snapshot);
        this.engineCheckpoints.set(id, checkpoints.slice(0, cpIndex + 1));
        db.run(`DELETE FROM engine_checkpoints WHERE device_id = ? AND timestamp > ?`, [id, cp.timestamp]);
      } else {
        this.engines.set(id, new Engine());
        this.engineCheckpoints.set(id, []);
        db.run(`DELETE FROM engine_checkpoints WHERE device_id = ?`, [id]);
      }

      const replayFrom = cp?.timestamp ?? 0;
      const relevantIds = this.groupIds.has(id) ? new Set(this.groups.find(g => g.id === id)?.memberDeviceIds ?? []) : [id];
      const historical = Array.from(relevantIds).flatMap(rId => this.allPosById.get(rId) ?? []).filter(p => p.timestamp > replayFrom).sort((a, b) => a.timestamp - b.timestamp);
      posById.set(id, historical);
    }

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

    for (const [id, engine] of this.engines) {
      if (engine.lastTimestamp) {
        engine.pruneHistory(cpCutoff);
        const checkpoints = this.engineCheckpoints.get(id) ?? [];
        const lastCp = checkpoints[checkpoints.length - 1];
        if (rawByDevice[id]?.length && (!lastCp || (engine.lastTimestamp - lastCp.timestamp) > CHECKPOINT_INTERVAL_MS)) {
          const cp = { timestamp: engine.lastTimestamp, snapshot: engine.createSnapshot() };
          checkpoints.push(cp);
          this.engineCheckpoints.set(id, checkpoints);
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
