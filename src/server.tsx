import { ClientMessageSchema, TraccarDeviceSchema, ServerMessageSchema } from "@/types";
import { db } from "./server/db";
import { getTraccarApiBase } from "./server/traccarUrlUtils";
import { loadConfig } from "./util/config";
import { parseArgs } from "util";
import { serve } from "bun";
import { ServerState } from "./server/serverState";
import { sessionStore } from "./server/sessionStore";
import { setVerbose, vlog } from "./util/logger";
import { TraccarAdminClient } from "./server/traccarClient";
import { getOrCreateTraccarPermanentToken } from "./server/traccarTokenManager";
import { z } from "zod";
import indexHtml from "./index.html";
import type { Config } from "./util/config";
import type { TraccarDevice, AppDevice, DevicePoint, EngineEvent, RawGpsPosition } from "@/types";
import type { Server, ServerWebSocket } from "bun";

class SafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeError";
  }
}

const isProduction = process.env.NODE_ENV === "production";

// Schema definitions
const TraccarUserSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
  email: z.string().optional()
});

let traccarUsersCache: Array<z.infer<typeof TraccarUserSchema>> = [];
const activeWebSockets = new Set<ServerWebSocket<WSData>>();

interface Principal {
  username: string;
  traccarToken: string;
  allowed: Set<number>;
  owned: Set<number>;
}

interface WSData {
  isAlive: boolean;
  principal: Principal | null;
}

// Handle CLI flags
const { values } = parseArgs({
  options: {
    verbose: { type: "boolean", short: "v" },
    port: { type: "string", short: "p", default: "3000" },
  }
});

setVerbose(!!values.verbose);
const port = parseInt(values.port, 10);

let config: Config;
try {
  config = await loadConfig();
} catch (e) {
  console.error("Error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const apiBase = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);

async function refreshTraccarUsersCache(authToken: string, reason: string): Promise<void> {
  try {
    const usersRes = await fetch(`${apiBase}/users`, {
      headers: { "Authorization": `Bearer ${authToken}`, "Accept": "application/json" }
    });
    if (!usersRes.ok) throw new Error(`[Users Cache] Failed to fetch: ${usersRes.status} ${usersRes.statusText}`);

    traccarUsersCache = z.array(TraccarUserSchema).parse(await usersRes.json());
    vlog(`[Users Cache] Refreshed (${reason}): count=${traccarUsersCache.length}`);
  } catch (e) {
    console.error(`[Users Cache] Background refresh error (${reason}):`, e);
  }
}

function isSQLiteConstraintError(err: unknown) {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("constraint") || msg.includes("unique");
}

const serverState = new ServerState(config.historyDays);

// Helper to broadcast device/group metadata (authorized subset only)
function broadcastConfig(targetUsername: string | null) {
  const cache = new Map<string, string>();

  for (const ws of activeWebSockets) {
    const principal = ws.data.principal;
    if (!principal) continue;
    if (targetUsername !== null && principal.username !== targetUsername) continue;

    const cacheKey = [
      Array.from(principal.allowed).sort((a, b) => a - b).join(","),
      Array.from(principal.owned).sort((a, b) => a - b).join(",")
    ].join("|");
    let msg = cache.get(cacheKey);

    if (!msg) {
      const { devices, groups } = serverState.getConfigProjection(principal.allowed);
      const allowedEntityIds = new Set<number>(Object.keys(devices).map(id => Number(id)));
      for (const group of groups) allowedEntityIds.add(group.id);
      const relevantDevices: Record<number, AppDevice> = Object.fromEntries(
        Object.entries(devices).map(([id, device]) => {
          const numId = Number(id);
          return [numId, { ...device, isOwner: principal.owned.has(numId) }];
        })
      );
      const relevantGroups = groups.map(g => ({
        ...g,
        isOwner: principal.owned.has(g.id)
      }));

      msg = JSON.stringify(ServerMessageSchema.parse({
        type: "config_update",
        payload: {
          devices: relevantDevices,
          groups: relevantGroups,
          allowedDeviceIds: Array.from(allowedEntityIds),
          ownedDeviceIds: Array.from(principal.owned)
        }
      }));
      cache.set(cacheKey, msg);
    }

    ws.send(msg);
  }
}

// Helper to broadcast state to active sockets based on per-user permissions
function broadcastUpdate(deviceIds: number[]) {
  const idsToSync = new Set(deviceIds);
  for (const deviceId of deviceIds) {
    const groups = serverState.deviceToGroupsMap[deviceId];
    if (groups) for (const gid of groups) idsToSync.add(gid);
  }

  // Cache serialized payloads for unique sets of IDs within this update batch
  const cache = new Map<string, string>();

  for (const ws of activeWebSockets) {
    const principal = ws.data.principal;
    if (!principal) continue;

    const visibleIds: number[] = [];
    for (const id of idsToSync) {
      if (principal.allowed.has(id)) visibleIds.push(id);
    }
    if (visibleIds.length === 0) continue;

    const cacheKey = visibleIds.sort((a, b) => a - b).join(",");
    let msg = cache.get(cacheKey);

    if (!msg) {
      const activePoints: Record<number, DevicePoint[]> = {};
      const events: Record<number, EngineEvent[]> = {};
      for (const id of visibleIds) {
        if (serverState.activePointsByDevice[id]) activePoints[id] = serverState.activePointsByDevice[id];
        if (serverState.eventsByDevice[id]) events[id] = serverState.eventsByDevice[id] ?? [];
      }
      msg = JSON.stringify(ServerMessageSchema.parse({ type: "positions_update", payload: { activePoints, events } }));
      cache.set(cacheKey, msg);
    }

    ws.send(msg);
  }
}

// Helper to start/restart admin client
let traccarClient: TraccarAdminClient | null = null;
function initTraccarClient(baseUrl: string, secure: boolean, token: string) {
  if (traccarClient) traccarClient.close();

  traccarClient = new TraccarAdminClient(baseUrl, secure, token, {
    onDevicesReceived: (devices: TraccarDevice[]) => {
      serverState.handleDevices(devices);

      const historyMs = config.historyDays * 24 * 60 * 60 * 1000;
      const backfillCutoff = Date.now() - historyMs;

      const devicesToBackfill = devices
        .map(d => d.id)
        .filter((id): id is number => !serverState.backfilled.has(id) && !serverState.inProgressBackfills.has(id));

      if (devicesToBackfill.length > 0) {
        void (async () => {
          vlog(`[Server] Starting persistent sequential backfill for ${devicesToBackfill.length} devices...`);
          for (const id of devicesToBackfill) {
            if (serverState.backfilled.has(id) || serverState.inProgressBackfills.has(id)) continue;
            serverState.inProgressBackfills.add(id);

            const lastTs = serverState.engines[id]?.lastTimestamp ?? null;
            const firstTs = serverState.positionsAll.find(p => p.device === id)?.timestamp ?? null;

            // Fetch head delta if we have reliable data, otherwise full window
            const isDelta = lastTs && firstTs && firstTs < backfillCutoff + (10 * 60000);
            const from = isDelta ? (lastTs + 1) : backfillCutoff;

            if (Date.now() - from < 60000) continue;

            try {
              vlog(`[Server] Device ${id} backfill: type=${isDelta ? "DELTA" : "FULL"}, from=${new Date(from).toISOString()}`);
              const history = await traccarClient!.fetchHistory(id, from, Date.now());
              if (history.length > 0 && serverState.handlePositions(history)) {
                broadcastUpdate([id]);
              }
              await new Promise(r => setTimeout(r, 200)); // Gentle delay for Traccar API

              // Only record backfill as complete after successfully fetching and processing history
              serverState.backfilled.add(id);
            } catch (err) {
              console.error(`[Server] History backfill failed for device ${id}:`, err);
            } finally {
              serverState.inProgressBackfills.delete(id);
            }
          }
          vlog(`[Server] Sequential backfill complete.`);
        })();
      }

      broadcastConfig(null);
    },
    onPositionsReceived: (positions: RawGpsPosition[]) => {
      if (serverState.handlePositions(positions)) {
        broadcastUpdate(Array.from(new Set(positions.map(p => p.device))));
      }
    }
  });
  traccarClient.connect();
}

// Config is validated and ready
const currentBaseUrl = config.traccarBaseUrl;
const currentToken = config.traccarApiToken;

const wsRouteHandler = (request: Request, server: Server<WSData>) => {
  vlog(`[WS] Upgrade request received. Origin: ${request.headers.get("origin")}`);
  const upgraded = server.upgrade(request, {
    data: { isAlive: true, principal: null }
  });
  vlog(`[WS] Upgrade result: ${upgraded}`);
  if (upgraded) return undefined;
  return new Response("Upgrade failed", { status: 400 });
};

serve<WSData>({
  port,
  routes: isProduction
    ? {
      "/api/ws": wsRouteHandler,
      "/*": async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        let file = Bun.file(`dist${pathname}`);
        if (await file.exists()) return new Response(file);
        file = Bun.file(`dist${pathname}/index.html`);
        if (await file.exists()) return new Response(file);
        return new Response(Bun.file("dist/index.html"));
      }
    }
    : {
      "/api/ws": wsRouteHandler,
      "/assets/**": Bun.file("src/assets"),
      "/*": indexHtml,
    },

  websocket: {
    async message(ws: ServerWebSocket<WSData>, message) {
      if (typeof message === "string" && message === '{"type":"pong"}') {
        ws.data.isAlive = true;
        return;
      }
      try {
        const data = ClientMessageSchema.parse(JSON.parse(message as string));
        ws.data.isAlive = true; // Any message indicates the client is alive

        switch (data.type) {
          case "pong":
            // Already handled above, but here for completeness
            break;
          case "login": {
            const { username: inputUsername, password } = data.payload;
            const { requestId } = data;
            try {
              const params = new URLSearchParams({ email: inputUsername, password });
              const sessionRes = await fetch(`${apiBase}/session`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
                body: params.toString()
              });

              if (!sessionRes.ok) {
                ws.send(JSON.stringify({ type: "error", message: "Invalid credentials", requestId }));
                return;
              }

              const user = TraccarUserSchema.parse(await sessionRes.json());
              const traccarToken = await getOrCreateTraccarPermanentToken(apiBase, user.login, password);
              void refreshTraccarUsersCache(traccarToken, `login:${user.login}`);

              const token = sessionStore.createSession(user.login, traccarToken);
              ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "login_success", token, requestId })));
            } catch (e) {
              console.error("[WS Login] Error:", e);
              ws.send(JSON.stringify({ type: "error", message: "Login failed", requestId }));
            }
            break;
          }

          case "authenticate": {
            vlog(`[WS] Authenticating client with session token: ${data.token.substring(0, 10)}...`);

            const session = sessionStore.getSession(data.token);
            if (!session) {
              ws.send(JSON.stringify({ type: "error", message: "Session expired", requestId: null }));
              ws.close(1008, "Session expired");
              return;
            }

            const { username, traccarToken } = session;

            const devicesUrl = `${apiBase}/devices`;

            const devicesRes = await fetch(devicesUrl, {
              headers: { "Authorization": `Bearer ${traccarToken}`, "Accept": "application/json" }
            });

            if (!devicesRes.ok) {
              ws.send(JSON.stringify({ type: "error", message: "Session expired", requestId: null }));
              sessionStore.deleteSession(data.token);
              ws.close(1008, "Session expired");
              return;
            }

            const devices = TraccarDeviceSchema.array().parse(await devicesRes.json());
            const traccarDeviceIds = new Set(devices.map(d => d.id));

            // Add shared devices by looking up shares for this user's Traccar ID
            const shared = db.query("SELECT deviceId, sharedBy FROM device_shares WHERE sharedWith = ?").all(username) as { deviceId: number, sharedBy: string }[];
            const sharedWithMeIds = new Set(shared.map(s => s.deviceId));
            const sharedByDeviceId = new Map(shared.map(s => [s.deviceId, s.sharedBy]));

            // Owned devices are those in Traccar that weren't explicitly shared WITH me by SOMEONE ELSE.
            // If I shared it with myself, or if it was just in my Traccar account, I'm the owner.
            const ownedPhysicalDeviceIds = new Set([...traccarDeviceIds].filter(id => {
              const sharedBy = sharedByDeviceId.get(id);
              return sharedBy === undefined || sharedBy === username;
            }));
            const allowedPhysicalDeviceIds = new Set([...traccarDeviceIds, ...sharedWithMeIds]);

            // Update server state with device metadata
            serverState.handleDevices(devices);

            const ownedGroupRows = db.query(`SELECT id FROM groups WHERE owner = ?`).all(username) as { id: number }[];
            const ownedGroupIds = new Set(ownedGroupRows.map(row => -row.id));
            const visibleGroups = serverState.getConfigProjection(allowedPhysicalDeviceIds).groups;
            const visibleGroupIds = new Set(visibleGroups.map(group => group.id));

            const ownedDeviceIds = new Set<number>([...ownedPhysicalDeviceIds, ...ownedGroupIds]);
            const allowedDeviceIds = new Set<number>([
              ...allowedPhysicalDeviceIds,
              ...visibleGroupIds,
              ...ownedGroupIds,
            ]);

            ws.data.principal = {
              username,
              traccarToken,
              allowed: allowedDeviceIds,
              owned: ownedDeviceIds
            };

            // Proactively refresh users cache on auth if empty to prevent 'User not found' on share
            if (traccarUsersCache.length === 0) {
              void refreshTraccarUsersCache(traccarToken, `auth:${username}`);
            }

            vlog(`[WS] Authentication successful for ${username}. Allowed: ${allowedDeviceIds.size}, Owned: ${ownedDeviceIds.size}`);

            // Get entities and determine root IDs for filtering snapshots
            const { devices: projectedDevices, groups } = serverState.getConfigProjection(allowedDeviceIds);
            const allEntities: Record<number, AppDevice> = { ...projectedDevices };
            const groupMemberIds = new Set<number>();
            for (const group of groups) {
              allEntities[group.id] = group;
              group.memberDeviceIds?.forEach(memberId => groupMemberIds.add(memberId));
            }
            const rootIds = Object.keys(allEntities)
              .map(Number)
              .filter(id => !groupMemberIds.has(id));

            const entitiesWithOwner = Object.fromEntries(
              Object.entries(allEntities).map(([id, entity]) => {
                const numericId = Number(id);
                return [numericId, { ...entity, isOwner: ownedDeviceIds.has(numericId) }];
              })
            );
            const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours

            // Only include snapshots for root entities that have been seen within the last 48 hours
            const filteredPoints: Record<number, DevicePoint[]> = {};
            const filteredEvents: Record<number, EngineEvent[]> = {};
            for (const id of rootIds) {
              const entity = entitiesWithOwner[id];
              if (serverState.activePointsByDevice[id] && entity) {
                const lastSeen = entity.lastSeen;
                if (lastSeen !== null && lastSeen > cutoff) {
                  filteredPoints[id] = serverState.activePointsByDevice[id];
                }
              }
              if (serverState.eventsByDevice[id]) {
                filteredEvents[id] = serverState.eventsByDevice[id] ?? [];
              }
            }

            // Send auth success with ownedDeviceIds (separate message)
            ws.send(JSON.stringify(ServerMessageSchema.parse({
              type: "auth_success",
              payload: { ownedDeviceIds: Array.from(ownedDeviceIds) }
            })));

            // Send initial state with entities and activity data (ownership in entities, no separate metadata)
            const payloadStr = JSON.stringify(ServerMessageSchema.parse({
              type: "initial_state",
              payload: {
                entities: entitiesWithOwner,
                activePointsByDevice: filteredPoints,
                eventsByDevice: filteredEvents,
                maptilerApiKey: config.maptilerApiKey,
              }
            }));
            ws.send(payloadStr);
            vlog(`[WS] Sending 'initial_state' of size: ${payloadStr.length} bytes for ${username}`);
            break;
          }

          default: {
            const { requestId } = data;
            const principal = ws.data.principal;
            if (!principal) {
              ws.send(JSON.stringify({ type: "error", message: "Session invalid or expired", requestId }));
              return;
            }

            const reqHeaders = {
              "Authorization": `Bearer ${principal.traccarToken}`,
              "Content-Type": "application/json",
              "Accept": "application/json"
            };
            const isOwned = (id: number) => principal.owned.has(id);
            const ensureOwned = (id: number) => {
              if (!isOwned(id)) throw new SafeError("Forbidden: You do not own this device");
            };
            try {
              switch (data.type) {
                case "create_group": {
                  const { name, icon, memberDeviceIds } = data.payload;
                  if (memberDeviceIds.length === 0) throw new SafeError("Cannot create an empty group");
                  const username = principal.username;
                  if (!username) throw new SafeError("Session missing username");
                  if (!memberDeviceIds.every((id: number) => isOwned(id))) {
                    throw new SafeError("Forbidden: Cannot create group with devices you do not own");
                  }

                  if (!memberDeviceIds.every((id: number) => serverState.devices[id])) {
                    throw new SafeError("Device not found");
                  }

                  let createdGroup: AppDevice | null = null;
                  try {
                    createdGroup = serverState.createGroup(name, icon, memberDeviceIds, username);
                  } catch (err) {
                    if (isSQLiteConstraintError(err)) {
                      throw new SafeError("Device already in another group");
                    }
                    throw err;
                  }

                  if (!createdGroup) {
                    throw new SafeError("Failed to create group");
                  }

                  principal.allowed.add(createdGroup.id);
                  principal.owned.add(createdGroup.id);
                  broadcastConfig(null);
                  broadcastUpdate([createdGroup.id, ...memberDeviceIds]);
                  ws.send(JSON.stringify(ServerMessageSchema.parse({
                    type: "create_success",
                    device: {
                      id: createdGroup.id,
                      name: createdGroup.name,
                      lastUpdate: null,
                      attributes: {}
                    },
                    requestId
                  })));
                  break;
                }
                case "update_device": {
                  const { deviceId, updates } = data.payload;
                  ensureOwned(deviceId);

                  if (deviceId < 0) {
                    const currentGroup = serverState.getGroupMetadata(deviceId);
                    if (!currentGroup) throw new SafeError("Group not found");
                    const ok = serverState.updateGroupMetadata(deviceId, updates);
                    if (!ok) throw new SafeError("Group not found");
                    broadcastConfig(null);
                    ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "update_success", deviceId, requestId })));
                    break;
                  }

                  if (!serverState.devices[deviceId]) throw new SafeError("Device not found");

                  const currentDevice = serverState.deviceMetadataById[deviceId];
                  if (!currentDevice) throw new SafeError("Device metadata not found");

                  if (updates.name !== undefined) {
                    const getRes = await fetch(`${apiBase}/devices/${deviceId}`, { headers: reqHeaders });
                    if (!getRes.ok) throw new SafeError("Device not found");
                    const currentRaw: unknown = await getRes.json();
                    if (!currentRaw || typeof currentRaw !== "object") {
                      throw new SafeError("Failed to read existing device data");
                    }
                    const current = currentRaw as Record<string, unknown>;

                    const putRes = await fetch(`${apiBase}/devices/${deviceId}`, {
                      method: "PUT",
                      headers: reqHeaders,
                      body: JSON.stringify({ ...current, name: updates.name })
                    });
                    if (!putRes.ok) {
                      const text = await putRes.text();
                      console.error(`[Traccar API Error] update_device_name: ${putRes.status} ${text}`);
                      throw new SafeError("Failed to update device name");
                    }
                    const updated = TraccarDeviceSchema.parse(await putRes.json());
                    serverState.handleDevices([updated]);
                  }

                  serverState.upsertDeviceMetadata(deviceId, updates);
                  broadcastConfig(null);
                  ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "update_success", deviceId, requestId })));
                  break;
                }
                case "delete_group": {
                  const { groupId } = data.payload;
                  ensureOwned(groupId);

                  const memberDeviceIds = serverState.getGroupMembers(groupId);
                  if (!serverState.deleteGroup(groupId)) throw new SafeError("Group not found");

                  principal.allowed.delete(groupId);
                  principal.owned.delete(groupId);
                  broadcastConfig(null);
                  if (memberDeviceIds.length > 0) broadcastUpdate(memberDeviceIds);
                  ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "delete_success", groupId, requestId })));
                  break;
                }
                case "add_device_to_group":
                case "remove_device_from_group": {
                  const { groupId, deviceId } = data.payload;
                  ensureOwned(groupId);

                  if (!serverState.devices[deviceId]) throw new SafeError("Device not found");
                  if (!isOwned(deviceId)) {
                    throw new SafeError("Forbidden: Cannot modify group membership for devices you do not own");
                  }

                  try {
                    let ok = false;
                    if (data.type === "add_device_to_group") {
                      ok = serverState.addDeviceToGroup(groupId, deviceId);
                    } else {
                      ok = serverState.removeDeviceFromGroup(groupId, deviceId);
                    }
                    if (!ok) throw new SafeError("Group not found");
                  } catch (err) {
                    if (isSQLiteConstraintError(err)) {
                      throw new SafeError("Device already in another group");
                    }
                    throw err;
                  }

                  broadcastConfig(null);
                  broadcastUpdate([deviceId, groupId]);
                  ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "update_success", deviceId: groupId, requestId })));
                  break;
                }
                case "share_device": {
                  const { deviceId, username: targetUsername } = data.payload;
                  ensureOwned(deviceId);
                  if (principal.username === targetUsername) throw new SafeError("Cannot share a device with yourself");

                  let targetUser = traccarUsersCache.find(u => u.login === targetUsername);
                  if (!targetUser) {
                    // Cache might be stale or empty, try one refresh
                    vlog(`[WS] User ${targetUsername} not in cache, attempting refresh...`);
                    await refreshTraccarUsersCache(principal.traccarToken, `share_retry:${targetUsername}`);
                    targetUser = traccarUsersCache.find(u => u.login === targetUsername);
                  }

                  if (!targetUser) throw new SafeError("User not found");

                  db.query("INSERT OR IGNORE INTO device_shares (deviceId, sharedWith, sharedBy, sharedAt) VALUES (?, ?, ?, ?)")
                    .run(deviceId, targetUser.login, principal.username, Date.now());

                  // For sharing, the target user will get new permissions on next auth
                  broadcastConfig(targetUser.login);
                  broadcastUpdate([deviceId]);

                  ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "share_success", deviceId, sharedWith: targetUser.login, requestId })));
                  break;
                }
                case "unshare_device": {
                  const { deviceId, username: targetUsername } = data.payload;
                  ensureOwned(deviceId);

                  db.query("DELETE FROM device_shares WHERE deviceId = ? AND sharedWith = ?")
                    .run(deviceId, targetUsername);
                  // For unsharing, the target user will lose permissions on next auth
                  broadcastConfig(targetUsername);

                  ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "unshare_success", deviceId, username: targetUsername, requestId })));
                  break;
                }
                case "get_shares": {
                  const allShares = db.query(
                    `SELECT deviceId, sharedWith, sharedAt FROM device_shares WHERE sharedBy = ?`
                  ).all(principal.username) as { deviceId: number; sharedWith: string; sharedAt: number }[];

                  // Filter based on currently authenticated devices to be safe
                  const sharesList = allShares
                    .filter(s => principal.owned.has(s.deviceId))
                    .map(s => {
                      const groupMetadata = serverState.getGroupMetadata(s.deviceId);
                      return {
                        ...s,
                        deviceName: groupMetadata?.name ?? serverState.devices[s.deviceId]?.name ?? `Device ${s.deviceId}`,
                      };
                    });

                  ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "shares_list", payload: sharesList, requestId })));
                  break;
                }
              }
            } catch (err: unknown) {
              let message = "An unexpected error occurred";
              if (err instanceof SafeError) {
                message = err.message;
              }
              const consoleError = err instanceof Error ? err.stack : String(err);
              console.error(`[WS RPC Error] ${data.type}:`, consoleError);
              ws.send(JSON.stringify(ServerMessageSchema.parse({ type: "error", message, requestId })));
            }
          }
        }
      } catch (e) {
        if (e instanceof z.ZodError) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid request data", requestId: null }));
        } else {
          console.error("Invalid WS message", e);
        }
      }
    },
    open(ws: ServerWebSocket<WSData>) {
      activeWebSockets.add(ws);
      vlog("[WS] Connection opened");
    },
    close(ws: ServerWebSocket<WSData>) {
      activeWebSockets.delete(ws);
      vlog("[WS] Connection closed");
    }
  },
  ...(isProduction ? {} : {
    development: {
      hmr: true,
      console: true,
    }
  }),
});

// Start Traccar admin connection if config is ready
if (currentBaseUrl && currentToken) {
  void refreshTraccarUsersCache(currentToken, "startup");
  initTraccarClient(currentBaseUrl, config.traccarSecure, currentToken);
}

// Periodically sends a "ping" to all clients and closes those that don't respond.
setInterval(() => {
  for (const ws of activeWebSockets) {
    if (!ws.data.isAlive) {
      vlog("[WS] Heartbeat timeout. Closing connection.");
      ws.close(1011, "Heartbeat timeout");
      continue;
    }
    ws.data.isAlive = false;
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30000); // 30 seconds

console.log(`🚀 Server running at http://localhost:${port}`);
