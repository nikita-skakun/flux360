import { ClientMessageSchema, TraccarDeviceSchema } from "@/types";
import { readLabels, removeLabel, upsertLabel } from "@/labels/store";
import { checkPlacement } from "@/labels/validation";
import { isAllowedOrigin } from "./server/originGuard";
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

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isLoginRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(clientIp);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(clientIp, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

interface Principal {
  username: string;
  traccarToken: string;
  traccarDeviceIds: Set<number>;
  allowed: Set<number>;
  owned: Set<number>;
}

interface WSData {
  isAlive: boolean;
  principal: Principal | null;
  clientIp: string;
}

// Handle CLI flags
const { values } = parseArgs({
  options: {
    verbose: { type: "boolean", short: "v" },
    port: { type: "string", short: "p", default: "6474" },
  }
});

setVerbose(!!values.verbose);
const port = parseInt(values.port, 10);

let config: Config;
try {
  config = loadConfig();
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

function recomputePrincipalPermissions(principal: Principal): void {
  const shared = db.query("SELECT deviceId, sharedBy FROM device_shares WHERE sharedWith = ?").all(principal.username) as { deviceId: number, sharedBy: string }[];
  const sharedWithMeIds = new Set(shared.map(s => s.deviceId));
  const sharedByDeviceId = new Map(shared.map(s => [s.deviceId, s.sharedBy]));

  const ownedPhysicalDeviceIds = new Set([...principal.traccarDeviceIds].filter(id => {
    const sharedBy = sharedByDeviceId.get(id);
    return sharedBy === undefined || sharedBy === principal.username;
  }));
  const allowedPhysicalDeviceIds = new Set([...principal.traccarDeviceIds, ...sharedWithMeIds]);

  const ownedGroupRows = db.query(`SELECT id FROM groups WHERE owner = ?`).all(principal.username) as { id: number }[];
  const ownedGroupIds = new Set(ownedGroupRows.map(row => -row.id));
  const visibleGroupIds = new Set(serverState.getConfigProjection(allowedPhysicalDeviceIds).groups.map(group => group.id));

  principal.owned = new Set([...ownedPhysicalDeviceIds, ...ownedGroupIds]);
  principal.allowed = new Set([...allowedPhysicalDeviceIds, ...visibleGroupIds, ...ownedGroupIds]);
}

function refreshPrincipal(username: string): void {
  for (const ws of activeWebSockets) {
    const principal = ws.data.principal;
    if (principal?.username !== username) continue;
    recomputePrincipalPermissions(principal);
  }
}

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

      msg = JSON.stringify({
        type: "config_update",
        payload: {
          devices: relevantDevices,
          groups: relevantGroups,
          allowedDeviceIds: Array.from(allowedEntityIds),
          ownedDeviceIds: Array.from(principal.owned)
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
        if (serverState.eventsByDevice[id]) events[id] = serverState.eventsByDevice[id];
      }
      msg = JSON.stringify({ type: "positions_update", payload: { activePoints, events } });
      cache.set(cacheKey, msg);
    }

    ws.send(msg);
  }
}

// Helper to start/restart admin client
let traccarClient: TraccarAdminClient | null = null;

/** Positions newer than this would not be worth a round trip. */
const HISTORY_FETCH_MIN_GAP_MS = 60_000;
/** Spacing between sequential Traccar history requests. */
const HISTORY_FETCH_SPACING_MS = 50;
/** A failed fetch is retried after this delay, then kept queued until it lands. */
const HISTORY_FETCH_RETRY_MS = 5_000;

/**
 * Per-device ranges that still need to come from Traccar. Requests are coalesced
 * and drained by one sequential pump, so a burst of out-of-order points cannot
 * queue the same device twice or stampede the Traccar API.
 */
const desiredHistory = new Map<number, { from: number; to: number }>();
let pumpingHistory = false;

function requestHistory(deviceId: number, from: number, to: number) {
  const existing = desiredHistory.get(deviceId);
  desiredHistory.set(deviceId, {
    from: Math.min(from, existing?.from ?? from),
    to: Math.max(to, existing?.to ?? to),
  });
  void pumpHistory();
}

function queueHistory(requests: { deviceId: number; from: number; to: number }[]) {
  for (const req of requests) requestHistory(req.deviceId, req.from, req.to);
}

async function pumpHistory() {
  if (pumpingHistory) return;
  pumpingHistory = true;
  try {
    while (desiredHistory.size > 0) {
      const entry = desiredHistory.entries().next().value;
      if (!entry) break;
      const [deviceId, range] = entry;
      desiredHistory.delete(deviceId);
      try {
        const history = await traccarClient!.fetchHistory(deviceId, range.from, range.to);
        if (history.length > 0 && serverState.handlePositions(history)) {
          broadcastUpdate([deviceId]);
          queueHistory(serverState.drainHistoryRequests());
        }
      } catch (err) {
        console.error(`[Server] History fetch failed for device ${deviceId}:`, err);
        // Keep the range queued. Without this a group whose runtime was cleared by a
        // failed rebuild would stay empty until something else happened to request it.
        requestHistory(deviceId, range.from, range.to);
        await new Promise(r => setTimeout(r, HISTORY_FETCH_RETRY_MS));
        continue;
      }
      await new Promise(r => setTimeout(r, HISTORY_FETCH_SPACING_MS));
    }
  } finally {
    pumpingHistory = false;
  }
}

function initTraccarClient(baseUrl: string, secure: boolean, token: string) {
  if (traccarClient) traccarClient.close();

  traccarClient = new TraccarAdminClient(baseUrl, secure, token, {
    onDevicesReceived: (devices: TraccarDevice[]) => {
      serverState.handleDevices(devices);
      queueHistory(serverState.drainHistoryRequests());

      // Catch the engine up from its checkpoint watermark. A device with no state
      // gets the whole retained window.
      const retainedFrom = Date.now() - config.historyDays * 24 * 60 * 60 * 1000;
      for (const device of devices) {
        const lastTs = serverState.engines[device.id]?.lastTimestamp ?? null;
        const from = lastTs !== null ? lastTs + 1 : retainedFrom;
        if (Date.now() - from < HISTORY_FETCH_MIN_GAP_MS) continue;
        vlog(`[Server] Device ${device.id} backfill from ${new Date(from).toISOString()}`);
        requestHistory(device.id, from, Date.now());
      }

      broadcastConfig(null);
    },
    onPositionsReceived: (positions: RawGpsPosition[]) => {
      if (serverState.handlePositions(positions)) {
        broadcastUpdate(Array.from(new Set(positions.map(p => p.device))));
      }
      queueHistory(serverState.drainHistoryRequests());
    }
  });
  traccarClient.connect();
}

// Config is validated and ready
const currentBaseUrl = config.traccarBaseUrl;
const currentToken = config.traccarApiToken;

function getClientIP(request: Request, server: Server<WSData>): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")?.trim()
    ?? server.requestIP(request)?.address
    ?? "127.0.0.1";
}

const wsRouteHandler = (request: Request, server: Server<WSData>) => {
  const origin = request.headers.get("origin");
  vlog(`[WS] Upgrade request received. Origin: ${origin}`);

  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`SEC_WS_ORIGIN: ${getClientIP(request, server)} ${origin}`);
    return new Response("Forbidden", { status: 403 });
  }

  const clientIp = getClientIP(request, server);
  const upgraded = server.upgrade(request, {
    data: { isAlive: true, principal: null, clientIp }
  });
  vlog(`[WS] Upgrade result: ${upgraded}`);
  if (upgraded) return undefined;
  return new Response("Upgrade failed", { status: 400 });
};

const server = serve<WSData>({
  port,
  routes: isProduction
    ? {
      "/api/ws": wsRouteHandler,
      "/*": async (request: Request, server: Server<WSData>) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/favicon.ico") {
          return new Response(null, { status: 204 });
        }
        if (pathname === "/" || pathname === "/index.html") {
          const file = Bun.file("dist/index.html");
          if (await file.exists()) return new Response(file);
        }

        const file = Bun.file(`dist${pathname}`);
        if (await file.exists()) return new Response(file);

        const clientIp = getClientIP(request, server);
        console.warn(`SEC_404: ${clientIp} ${pathname}`);
        return new Response("Not Found", { status: 404 });
      }
    }
    : {
      "/api/ws": wsRouteHandler,
      "/src/**": indexHtml,
      "/assets/**": Bun.file("src/assets"),
      "/": indexHtml,
      "/index.html": indexHtml,
      "/index.css": indexHtml,
      "/client.tsx": indexHtml,
      "/*": (request: Request, server: Server<WSData>) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/favicon.ico") {
          return new Response(null, { status: 204 });
        }
        const clientIp = getClientIP(request, server);
        console.warn(`SEC_404: ${clientIp} ${pathname}`);
        return new Response("Not Found", { status: 404 });
      }
    },

  websocket: {
    async message(ws: ServerWebSocket<WSData>, message) {
      try {
        const data = ClientMessageSchema.parse(JSON.parse(message as string));
        ws.data.isAlive = true; // Any message indicates the client is alive

        switch (data.type) {
          case "pong":
            break;
          case "login": {
            const { username: inputUsername, password } = data.payload;
            const { requestId } = data;
            if (isLoginRateLimited(ws.data.clientIp)) {
              console.warn(`SEC_LOGIN_RATE: ${ws.data.clientIp}`);
              ws.send(JSON.stringify({ type: "error", message: "Too many login attempts, try again later", requestId }));
              return;
            }
            try {
              const params = new URLSearchParams({ email: inputUsername, password });
              const sessionRes = await fetch(`${apiBase}/session`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
                body: params.toString()
              });

              if (!sessionRes.ok) {
                console.warn(`SEC_AUTH_FAIL: ${ws.data.clientIp}`);
                ws.send(JSON.stringify({ type: "error", message: "Invalid credentials", requestId }));
                return;
              }

              const user = TraccarUserSchema.parse(await sessionRes.json());
              const traccarToken = await getOrCreateTraccarPermanentToken(apiBase, user.login, password);
              void refreshTraccarUsersCache(traccarToken, `login:${user.login}`);

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
              ws.send(JSON.stringify({ type: "error", message: "Session expired" }));
              ws.close(1008, "Session expired");
              return;
            }

            const { username, traccarToken } = session;

            const devicesUrl = `${apiBase}/devices`;

            let devicesRes: Response;
            try {
              devicesRes = await fetch(devicesUrl, {
                headers: { "Authorization": `Bearer ${traccarToken}`, "Accept": "application/json" }
              });
            } catch (error) {
              // Traccar being unreachable says nothing about whether this session is
              // valid, so the session is left alone and the client is told to retry.
              console.error(`[WS] Device lookup failed for ${username}:`, error);
              ws.send(JSON.stringify({ type: "error", message: "Tracking backend is unavailable" }));
              ws.close(1011, "Upstream unavailable");
              return;
            }

            // Only a rejection of the credential itself ends the session. A 403 can also
            // mean the account lacks permission rather than that the token is dead, but
            // holding a session that cannot do anything is worse than asking to log in.
            if (devicesRes.status === 401 || devicesRes.status === 403) {
              ws.send(JSON.stringify({ type: "error", message: "Session expired" }));
              sessionStore.deleteSession(data.token);
              ws.close(1008, "Session expired");
              return;
            }

            if (!devicesRes.ok) {
              console.error(`[WS] Device lookup for ${username} returned HTTP ${devicesRes.status}`);
              ws.send(JSON.stringify({ type: "error", message: "Tracking backend is unavailable" }));
              ws.close(1011, "Upstream unavailable");
              return;
            }

            const devices = TraccarDeviceSchema.array().parse(await devicesRes.json());

            // Update server state with device metadata
            serverState.handleDevices(devices);

            const principal: Principal = {
              username,
              traccarToken,
              traccarDeviceIds: new Set(devices.map(d => d.id)),
              allowed: new Set(),
              owned: new Set()
            };
            recomputePrincipalPermissions(principal);
            ws.data.principal = principal;

            const ownedDeviceIds = principal.owned;
            const allowedDeviceIds = principal.allowed;

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
            const cutoff = Date.now() - config.historyDays * 24 * 60 * 60 * 1000;

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
                filteredEvents[id] = serverState.eventsByDevice[id];
              }
            }

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
                historyDays: config.historyDays,
              }
            });
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

                  refreshPrincipal(username);
                  broadcastConfig(null);
                  broadcastUpdate([createdGroup.id, ...memberDeviceIds]);
                  ws.send(JSON.stringify({
                    type: "create_success",
                    device: {
                      id: createdGroup.id,
                      name: createdGroup.name,
                      lastUpdate: null,
                      attributes: {}
                    },
                    requestId
                  }));
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
                    ws.send(JSON.stringify({ type: "update_success", deviceId, requestId }));
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
                  ws.send(JSON.stringify({ type: "update_success", deviceId, requestId }));
                  break;
                }
                case "delete_group": {
                  const { groupId } = data.payload;
                  ensureOwned(groupId);

                  const memberDeviceIds = serverState.getGroupMembers(groupId);
                  if (!serverState.deleteGroup(groupId)) throw new SafeError("Group not found");

                  refreshPrincipal(principal.username);
                  broadcastConfig(null);
                  if (memberDeviceIds.length > 0) broadcastUpdate(memberDeviceIds);
                  ws.send(JSON.stringify({ type: "delete_success", groupId, requestId }));
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

                  refreshPrincipal(principal.username);
                  broadcastConfig(null);
                  broadcastUpdate([deviceId, groupId]);
                  ws.send(JSON.stringify({ type: "update_success", deviceId: groupId, requestId }));
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

                  refreshPrincipal(targetUser.login);
                  broadcastConfig(targetUser.login);
                  broadcastUpdate([deviceId]);

                  ws.send(JSON.stringify({ type: "share_success", deviceId, sharedWith: targetUser.login, requestId }));
                  break;
                }
                case "unshare_device": {
                  const { deviceId, username: targetUsername } = data.payload;
                  ensureOwned(deviceId);

                  db.query("DELETE FROM device_shares WHERE deviceId = ? AND sharedWith = ?")
                    .run(deviceId, targetUsername);
                  refreshPrincipal(targetUsername);
                  broadcastConfig(targetUsername);

                  ws.send(JSON.stringify({ type: "unshare_success", deviceId, username: targetUsername, requestId }));
                  break;
                }
                case "list_labels": {
                  const { entityId } = data.payload;
                  ensureOwned(entityId);
                  ws.send(JSON.stringify({
                    type: "labels_list",
                    payload: { entityId, labels: readLabels(entityId) },
                    requestId
                  }));
                  break;
                }
                case "get_history": {
                  const { entityId, from, to } = data.payload;
                  ensureOwned(entityId);
                  if (!traccarClient) throw new SafeError("Tracking backend is not connected");
                  const memberIds = entityId < 0 ? serverState.getGroupMembers(entityId) : [entityId];
                  if (memberIds.length === 0) throw new SafeError("This entity has no devices");

                  const fixes: { device: number; geo: [number, number]; accuracy: number; timestamp: number }[] = [];
                  for (const memberId of memberIds) {
                    for (const fix of await traccarClient.fetchHistory(memberId, from, to)) {
                      fixes.push({ device: fix.device, geo: [fix.geo[0], fix.geo[1]], accuracy: fix.accuracy, timestamp: fix.timestamp });
                    }
                  }
                  fixes.sort((a, b) => a.timestamp - b.timestamp);
                  ws.send(JSON.stringify({ type: "history_chunk", payload: { entityId, fixes }, requestId }));
                  break;
                }
                case "set_label": {
                  const { label } = data.payload;
                  ensureOwned(label.deviceId);
                  const existing = readLabels(label.deviceId);
                  const placement = checkPlacement(existing.filter(other => other.id !== label.id), label);
                  if (!placement.ok) throw new SafeError(placement.reason);
                  upsertLabel(label);
                  ws.send(JSON.stringify({
                    type: "labels_list",
                    payload: { entityId: label.deviceId, labels: readLabels(label.deviceId) },
                    requestId
                  }));
                  break;
                }
                case "remove_label": {
                  const { entityId, id } = data.payload;
                  ensureOwned(entityId);
                  removeLabel(entityId, id);
                  ws.send(JSON.stringify({
                    type: "labels_list",
                    payload: { entityId, labels: readLabels(entityId) },
                    requestId
                  }));
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
          ws.send(JSON.stringify({ type: "error", message: "Invalid request data" }));
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

let shuttingDown = false;

// Docker sends SIGTERM and waits ten seconds for the process to leave before SIGKILL.
// The server runs as PID 1 in the container, and the kernel will not apply the default
// terminate action to PID 1 unless a handler is installed, so without this the signal
// is silently dropped and every restart costs the full grace period.
function shutdown(signal: "SIGTERM" | "SIGINT"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);

  try {
    void server.stop(true);
    traccarClient?.close();
    serverState.flush();
    db.close();
    console.log("Shutdown complete.");
  } catch (error) {
    console.error("Shutdown failed:", error);
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
