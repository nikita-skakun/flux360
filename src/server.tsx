import { ClientMessageSchema, TraccarDeviceSchema } from "@/types";
import { db } from "./server/db";
import { getTraccarApiBase } from "./server/traccarUrlUtils";
import { loadConfig } from "./util/config";
import { numericEntries } from "@/util/record";
import { parseArgs } from "util";
import { register, deregister, getSession, addAllowedDevice, removeAllowedDevice } from "./server/userSessions";
import { serve } from "bun";
import { ServerState } from "./server/serverState";
import { sessionStore } from "./server/sessionStore";
import { setVerbose, vlog } from "./util/logger";
import { TraccarAdminClient } from "./server/traccarClient";
import { TraccarTokenManager } from "./server/traccarTokenManager";
import { z } from "zod";
import indexHtml from "./index.html";
import type { Config } from "./util/config";
import type { NormalizedPosition, TraccarDevice, AppDevice, DevicePoint, EngineEvent } from "@/types";
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
  login: z.string().min(1),
  email: z.string().optional()
});

let traccarUsersCache: Array<z.infer<typeof TraccarUserSchema>> = [];
const activeWebSockets = new Set<ServerWebSocket<WSData>>();

interface WSData {
  username: string | null;
  isAlive: boolean;
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
    if (!usersRes.ok) throw new Error(`Failed to fetch users for cache refresh: ${usersRes.status} ${usersRes.statusText}`);

    traccarUsersCache = z.array(TraccarUserSchema).parse(await usersRes.json());
    vlog(`[Users Cache] Refreshed (${reason}): count=${traccarUsersCache.length}`);
  } catch (e) {
    console.error(`[Users Cache] Background refresh error (${reason}):`, e);
  }
}

const serverState = new ServerState(config.historyDays);

// Helper to collect snapshots and events for a set of device IDs
function collectDeviceData(
  ids: Iterable<number>,
  applySnapshotCutoff: boolean,
  snapshotCutoff: number,
  entities: Record<number, AppDevice>
): { activePoints: Record<number, DevicePoint[]>; events: Record<number, EngineEvent[]> } {
  const activePoints: Record<number, DevicePoint[]> = {};
  const events: Record<number, EngineEvent[]> = {};

  for (const id of ids) {
    if (serverState.activePointsByDevice[id]) {
      const include = applySnapshotCutoff
        ? entities[id]?.lastSeen != null && entities[id].lastSeen > snapshotCutoff
        : true;
      if (include) {
        activePoints[id] = serverState.activePointsByDevice[id];
      }
    }
    if (serverState.eventsByDevice[id]) {
      events[id] = serverState.eventsByDevice[id];
    }
  }

  return { activePoints, events };
}

// Helper to broadcast device/group metadata (authorized subset only)
function broadcastConfig(targetUsername?: string) {
  const cache = new Map<string, string>();

  for (const ws of activeWebSockets) {
    const session = ws.data.username ? getSession(ws.data.username) : undefined;
    if (!session) continue;
    if (targetUsername !== undefined && ws.data.username !== targetUsername) continue;

    // Permissions set + ownership set is the cache key
    const cacheKey = [
      Array.from(session.allowed).sort((a, b) => a - b).join(","),
      Array.from(session.owned).sort((a, b) => a - b).join(",")
    ].join("|");
    let msg = cache.get(cacheKey);

    if (!msg) {
      const relevantDevices: Record<number, AppDevice> = {};
      for (const [id, device] of numericEntries(serverState.devices)) {
        if (session.allowed.has(id)) {
          relevantDevices[id] = { ...device, isOwner: session.owned.has(id) };
        }
      }
      const relevantGroups = serverState.groups
        .filter(g => session.allowed.has(g.id) || (g.memberDeviceIds?.some(mid => session.allowed.has(mid)) ?? false))
        .map(g => ({ ...g, isOwner: session.owned.has(g.id) }));

      msg = JSON.stringify({
        type: "config_update",
        payload: {
          devices: relevantDevices,
          groups: relevantGroups,
          allowedDeviceIds: Array.from(session.allowed),
          ownedDeviceIds: Array.from(session.owned)
        }
      });
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
    const session = ws.data.username ? getSession(ws.data.username) : undefined;
    if (!session) continue;

    // Find subset of updated IDs this user is allowed to see
    const visibleIds: number[] = [];
    for (const id of idsToSync) {
      if (session.allowed.has(id)) visibleIds.push(id);
    }
    if (visibleIds.length === 0) continue;

    // Use sorted ID string as cache key to share serialized payloads between users with same access
    const cacheKey = visibleIds.sort((a, b) => a - b).join(",");
    let msg = cache.get(cacheKey);

    if (!msg) {
      const activePoints: Record<number, DevicePoint[]> = {};
      const events: Record<number, EngineEvent[]> = {};
      for (const id of visibleIds) {
        if (serverState.activePointsByDevice[id]) activePoints[id] = serverState.activePointsByDevice[id];
        if (serverState.eventsByDevice[id]) events[id] = serverState.eventsByDevice[id] ?? [];
      }
      msg = JSON.stringify({ type: "positions_update", payload: { activePoints, events } });
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
        .filter((id): id is number => id !== undefined && !serverState.backfilled.has(id) && !serverState.inProgressBackfills.has(id));

      if (devicesToBackfill.length > 0) {
        (async () => {
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

      broadcastConfig();
    },
    onPositionsReceived: (positions: NormalizedPosition[]) => {
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
const tokenManager = new TraccarTokenManager(currentBaseUrl, config.traccarSecure);

const wsRouteHandler = (request: Request, server: Server<WSData>) => {
  vlog(`[WS] Upgrade request received. Origin: ${request.headers.get("origin")}`);
  const upgraded = server.upgrade(request, {
    data: { username: null, isAlive: true }
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
      "/*": indexHtml as never,
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
              const traccarToken = await tokenManager.getOrCreateTraccarPermanentToken(user.login, password);
              refreshTraccarUsersCache(traccarToken, `login:${user.login}`);

              const token = sessionStore.createSession(user.login, traccarToken);
              ws.send(JSON.stringify({ type: "login_success", token, requestId }));
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
            const shared = db.query("SELECT device_id, shared_by_username FROM device_shares WHERE shared_with_username = ?").all(username) as { device_id: number, shared_by_username: string }[];
            const sharedWithMeIds = new Set(shared.map(s => s.device_id));

            // Owned devices are those in Traccar that weren't explicitly shared WITH me by SOMEONE ELSE.
            // If I shared it with myself, or if it was just in my Traccar account, I'm the owner.
            const ownedDeviceIds = new Set([...traccarDeviceIds].filter(id => {
              const share = shared.find(s => s.device_id === id);
              return !share || share.shared_by_username === username;
            }));
            const allowedDeviceIds = new Set([...traccarDeviceIds, ...sharedWithMeIds]);

            // Update server state with device metadata
            serverState.handleDevices(devices);

            ws.data.username = username;
            register(username, traccarToken, allowedDeviceIds, ownedDeviceIds);

            // Proactively refresh users cache on auth if empty to prevent 'User not found' on share
            if (traccarUsersCache.length === 0) {
              refreshTraccarUsersCache(traccarToken, `auth:${username}`);
            }

            vlog(`[WS] Authentication successful for ${username}. Allowed: ${allowedDeviceIds.size}, Owned: ${ownedDeviceIds.size}`);

            // Get entities and determine root IDs for filtering snapshots
            const { entities: allEntities, rootIds } = serverState.getMetadata(allowedDeviceIds);
            const entitiesWithOwner = Object.fromEntries(
              Object.entries(allEntities).map(([id, entity]) => {
                const numericId = Number(id);
                return [numericId, { ...entity, isOwner: ownedDeviceIds.has(numericId) }];
              })
            );
            const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours

            // Only include snapshots for root entities that have been seen within the last 48 hours
            const { activePoints: filteredPoints, events: filteredEvents } = collectDeviceData(rootIds, true, cutoff, entitiesWithOwner);

            // Send auth success with ownedDeviceIds (separate message)
            ws.send(JSON.stringify({
              type: "auth_success",
              payload: { ownedDeviceIds: Array.from(ownedDeviceIds) }
            }));

            // Send initial state with entities and activity data (ownership in entities, no separate metadata)
            const payloadStr = JSON.stringify({
              type: "initial_state",
              payload: {
                entities: entitiesWithOwner,
                activePointsByDevice: filteredPoints,
                eventsByDevice: filteredEvents,
                maptilerApiKey: config.maptilerApiKey,
              }
            });
            ws.send(payloadStr);
            vlog(`[WS] Sending 'initial_state' of size: ${payloadStr.length} bytes for ${username}`);
            break;
          }

          default: {
            const { requestId } = data;
            const session = ws.data.username ? getSession(ws.data.username) : undefined;
            if (!session) {
              ws.send(JSON.stringify({ type: "error", message: "Session invalid or expired", requestId }));
              return;
            }

            const reqHeaders = {
              "Authorization": `Bearer ${session.traccarToken}`,
              "Content-Type": "application/json",
              "Accept": "application/json"
            };
            const isOwned = (id: number) => session.owned.has(id);
            const ensureOwned = (id: number) => {
              if (!isOwned(id)) throw new SafeError("Forbidden: You do not own this device");
            };
            try {
              switch (data.type) {
                case "create_group": {
                  const { name, emoji, memberDeviceIds } = data.payload;
                  if (!memberDeviceIds.every((id: number) => isOwned(id))) {
                    throw new SafeError("Forbidden: Cannot create group with devices you do not own");
                  }

                  const res = await fetch(`${apiBase}/devices`, {
                    method: "POST",
                    headers: reqHeaders,
                    body: JSON.stringify({
                      name,
                      uniqueId: `group-${ws.data.username ?? "unknown"}-${Date.now()}`,
                      attributes: { emoji, memberDeviceIds: JSON.stringify(memberDeviceIds) }
                    })
                  });
                  if (!res.ok) {
                    const text = await res.text();
                    console.error(`[Traccar API Error] create_group: ${res.status} ${text}`);
                    throw new SafeError("Failed to create group on the backend service");
                  }
                  const device = TraccarDeviceSchema.parse(await res.json());
                  serverState.handleDevices([device]);
                  ws.send(JSON.stringify({ type: "create_success", device, requestId }));
                  break;
                }
                case "update_device": {
                  const { deviceId, updates } = data.payload;
                  ensureOwned(deviceId);

                  const getRes = await fetch(`${apiBase}/devices/${deviceId}`, { headers: reqHeaders });
                  if (!getRes.ok) throw new SafeError("Device not found");
                  const current = await getRes.json();

                  const attributes = { ...current.attributes };
                  if (updates.emoji !== undefined) attributes['emoji'] = updates.emoji;
                  if (updates.color !== undefined) attributes['color'] = updates.color;
                  if (updates.motionProfile !== undefined) attributes['motionProfile'] = updates.motionProfile;

                  const putRes = await fetch(`${apiBase}/devices/${deviceId}`, {
                    method: "PUT",
                    headers: reqHeaders,
                    body: JSON.stringify({ ...current, name: updates.name || current.name, attributes })
                  });
                  if (!putRes.ok) {
                    const text = await putRes.text();
                    console.error(`[Traccar API Error] update_device: ${putRes.status} ${text}`);
                    throw new SafeError("Failed to update device settings");
                  }
                  const updated = TraccarDeviceSchema.parse(await putRes.json());
                  serverState.handleDevices([updated]);
                  ws.send(JSON.stringify({ type: "update_success", deviceId, requestId }));
                  break;
                }
                case "delete_group": {
                  const { groupId } = data.payload;
                  ensureOwned(groupId);

                  const res = await fetch(`${apiBase}/devices/${groupId}`, { method: "DELETE", headers: reqHeaders });
                  if (!res.ok) {
                    const text = await res.text();
                    console.error(`[Traccar API Error] delete_group: ${res.status} ${text}`);
                    throw new SafeError("Failed to delete group");
                  }
                  ws.send(JSON.stringify({ type: "delete_success", groupId, requestId }));
                  break;
                }
                case "add_device_to_group":
                case "remove_device_from_group": {
                  const { groupId, deviceId } = data.payload;
                  ensureOwned(groupId);

                  const getRes = await fetch(`${apiBase}/devices/${groupId}`, { headers: reqHeaders });
                  if (!getRes.ok) throw new SafeError("Group not found");
                  const current = await getRes.json();

                  let memberDeviceIds: number[] = current.attributes?.memberDeviceIds ? JSON.parse(current.attributes.memberDeviceIds) : [];
                  if (data.type === "add_device_to_group") {
                    if (!memberDeviceIds.includes(deviceId)) memberDeviceIds.push(deviceId);
                  } else {
                    memberDeviceIds = memberDeviceIds.filter(id => id !== deviceId);
                  }

                  const putRes = await fetch(`${apiBase}/devices/${groupId}`, {
                    method: "PUT",
                    headers: reqHeaders,
                    body: JSON.stringify({ ...current, attributes: { ...current.attributes, memberDeviceIds: JSON.stringify(memberDeviceIds) } })
                  });
                  if (!putRes.ok) {
                    const text = await putRes.text();
                    console.error(`[Traccar API Error] membership: ${putRes.status} ${text}`);
                    throw new SafeError("Failed to update group membership");
                  }
                  const updated = TraccarDeviceSchema.parse(await putRes.json());
                  serverState.handleDevices([updated]);
                  ws.send(JSON.stringify({ type: "update_success", deviceId: groupId, requestId }));
                  break;
                }
                case "share_device": {
                  const { deviceId, username: targetUsername } = data.payload;
                  ensureOwned(deviceId);
                  if (ws.data.username === targetUsername) throw new SafeError("Cannot share a device with yourself");

                  let targetUser = traccarUsersCache.find(u => u.login === targetUsername);
                  if (!targetUser) {
                    // Cache might be stale or empty, try one refresh
                    vlog(`[WS] User ${targetUsername} not in cache, attempting refresh...`);
                    await refreshTraccarUsersCache(session.traccarToken, `share_retry:${targetUsername}`);
                    targetUser = traccarUsersCache.find(u => u.login === targetUsername);
                  }

                  if (!targetUser) throw new SafeError("User not found");

                  db.query("INSERT OR IGNORE INTO device_shares (device_id, shared_with_username, shared_by_username, shared_at) VALUES (?, ?, ?, ?)")
                    .run(deviceId, targetUser.login, ws.data.username!, Date.now());

                  addAllowedDevice(targetUser.login, deviceId);
                  // Push new device metadata and current positions to the target user
                  broadcastConfig(targetUser.login);
                  broadcastUpdate([deviceId]);

                  ws.send(JSON.stringify({ type: "share_success", deviceId, sharedWith: targetUser.login, requestId }));
                  break;
                }
                case "unshare_device": {
                  const { deviceId, username: targetUsername } = data.payload;
                  ensureOwned(deviceId);

                  db.query("DELETE FROM device_shares WHERE device_id = ? AND shared_with_username = ?")
                    .run(deviceId, targetUsername);
                  removeAllowedDevice(targetUsername, deviceId);

                  // Update target user's UI
                  broadcastConfig(targetUsername);

                  ws.send(JSON.stringify({ type: "unshare_success", deviceId, username: targetUsername, requestId }));
                  break;
                }
                case "get_shares": {
                  const allShares = db.query(
                    `SELECT device_id, shared_with_username, shared_at FROM device_shares WHERE shared_by_username = ?`
                  ).all(ws.data.username) as { device_id: number; shared_with_username: string; shared_at: number }[];

                  // Filter based on currently authenticated devices to be safe
                  const sharesList = allShares
                    .filter(s => session.owned.has(s.device_id))
                    .map(s => ({
                      deviceId: s.device_id,
                      deviceName: serverState.devices[s.device_id]?.name ?? `Device ${s.device_id}`,
                      sharedWith: s.shared_with_username,
                      sharedAt: s.shared_at,
                    }));

                  ws.send(JSON.stringify({ type: "shares_list", payload: sharesList, requestId }));
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
              ws.send(JSON.stringify({ type: "error", message, requestId }));
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
      if (ws.data.username) {
        deregister(ws.data.username);
      }
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
  refreshTraccarUsersCache(currentToken, "startup");
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
