import { ClientMessageSchema, TraccarDeviceSchema } from "@/types";
import { db } from "./server/db";
import { getTraccarApiBase } from "./server/traccarUrlUtils";
import { loadConfig } from "./util/config";
import { numericEntries } from "@/util/record";
import { parseArgs } from "util";
import { serve } from "bun";
import { ServerState } from "./server/serverState";
import { setVerbose, vlog } from "./util/logger";
import { TraccarAdminClient } from "./server/traccarClient";
import { z } from "zod";
import indexHtml from "./index.html";
import type { Config } from "./util/config";
import type { NormalizedPosition, TraccarDevice, AppDevice, DevicePoint, EngineEvent } from "@/types";
import type { Server, ServerWebSocket } from "bun";

const isProduction = process.env.NODE_ENV === "production";

// Schema definitions
const LoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});
const DeviceIdSchema = z.object({ id: z.coerce.number() });
const UsernameSchema = z.object({ username: z.string().min(1) });

interface WSData {
  username: string | null;
  traccarToken: string | null;
  allowedDeviceIds: Set<number>;
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
        ? entities[id]?.lastSeen != null && entities[id]!.lastSeen > snapshotCutoff
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

// Helper to broadcast state to specific device topics
function broadcastUpdate(server: Server<WSData>, deviceIds?: number[]) {
  // Determine which IDs to sync (root entities only)
  let idsToSync: number[];
  if (deviceIds === undefined) {
    idsToSync = Object.keys(serverState.activePointsByDevice).map(Number);
  } else {
    // Include groups that contain any of the devices, then filter to root entities
    const allIds = new Set(deviceIds);
    for (const deviceId of deviceIds) {
      const groups = serverState.deviceToGroupsMap[deviceId];
      if (groups) {
        for (const gid of groups) allIds.add(gid);
      }
    }
    const { rootIds } = serverState.getMetadata(allIds);
    idsToSync = Array.from(allIds).filter(id => rootIds.includes(id));
  }

  const { activePoints: activePointsPayload, events: eventsPayload } = collectDeviceData(idsToSync, false, 0, {});

  // Only send if there's actual data
  if (Object.keys(activePointsPayload).length === 0 && Object.keys(eventsPayload).length === 0) {
    return;
  }

  for (const id of idsToSync) {
    if (activePointsPayload[id] || eventsPayload[id]) {
      server.publish(`device-${id}`, JSON.stringify({
        type: "positions_update",
        payload: {
          activePoints: { [id]: activePointsPayload[id] },
          events: { [id]: eventsPayload[id] ?? [] }
        }
      }));
    }
  }
}

// Helper to start/restart admin client
let traccarClient: TraccarAdminClient | null = null;
function initTraccarClient(server: Server<WSData>, baseUrl: string, secure: boolean, token: string) {
  if (traccarClient) traccarClient.close();

  traccarClient = new TraccarAdminClient(baseUrl, secure, token, {
    onDevicesReceived: (devices: TraccarDevice[]) => {
      serverState.handleDevices(devices);

      const historyMs = config.historyDays * 24 * 60 * 60 * 1000;
      const backfillCutoff = Date.now() - historyMs;

      const devicesToBackfill = devices
        .map(d => d.id)
        .filter((id): id is number => id !== undefined && !serverState.backfilled.has(id));

      if (devicesToBackfill.length > 0) {
        devicesToBackfill.forEach(id => serverState.backfilled.add(id));

        (async () => {
          vlog(`[Server] Starting persistent sequential backfill for ${devicesToBackfill.length} devices...`);
          for (const id of devicesToBackfill) {
            const lastTs = serverState.engines[id]?.lastTimestamp ?? null;
            const firstTs = serverState.positionsAll.find(p => p.device === id)?.timestamp ?? null;

            // Fetch head delta if we have reliable data, otherwise full window
            const isDelta = lastTs && firstTs && firstTs < backfillCutoff + (10 * 60000);
            const from = isDelta ? (lastTs! + 1) : backfillCutoff;

            if (Date.now() - from < 60000) continue;

            try {
              vlog(`[Server] Device ${id} backfill: type=${isDelta ? "DELTA" : "FULL"}, from=${new Date(from).toISOString()}`);
              const history = await traccarClient!.fetchHistory(id, from, Date.now());
              if (history.length > 0 && serverState.handlePositions(history)) {
                broadcastUpdate(server, [id]);
              }
              await new Promise(r => setTimeout(r, 200)); // Gentle delay for Traccar API
            } catch (err) {
              console.error(`[Server] History backfill failed for device ${id}:`, err);
            }
          }
          vlog(`[Server] Sequential backfill complete.`);
        })();
      }

      // Broadcast global device changes to relevant topics
      for (const [id, device] of numericEntries(serverState.devices)) {
        server.publish(`device-${id}`, JSON.stringify({
          type: "config_update",
          payload: {
            devices: { [id]: { ...device, isOwner: false } },
            groups: serverState.groups.filter(g => g.id === id || (g.memberDeviceIds?.includes(id) ?? false))
          }
        }));
      }
    },
    onPositionsReceived: (positions: NormalizedPosition[]) => {
      if (serverState.handlePositions(positions)) {
        broadcastUpdate(server, Array.from(new Set(positions.map(p => p.device))));
      }
    }
  });
  traccarClient.connect();
}


// Session store and token manager for WebSocket authentication
import { sessionStore } from "./server/sessionStore";
import { TraccarTokenManager } from "./server/traccarTokenManager";

async function verifyTraccarSession(request: Request): Promise<{ username: string; ownedDeviceIds: number[]; traccarToken: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  try {
    const [authType, token] = authHeader.split(" ");
    if (authType !== "Bearer" || !token) return null;

    const session = sessionStore.getSession(token);
    if (!session) return null;

    const base = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);

    const devicesRes = await fetch(`${base}/devices`, {
      headers: { "Authorization": `Bearer ${session.traccarToken}`, "Accept": "application/json" }
    });

    if (!devicesRes.ok) return null;

    const devices = z.array(z.object({ id: z.number() })).parse(await devicesRes.json());
    return {
      username: session.username,
      ownedDeviceIds: devices.map(d => d.id),
      traccarToken: session.traccarToken
    };
  } catch (e) {
    return null;
  }
}

// Config is validated and ready
const currentBaseUrl = config.traccarBaseUrl;
const currentToken = config.traccarApiToken;
const tokenManager = new TraccarTokenManager(currentBaseUrl, config.traccarSecure);

let serverInst: Server<WSData>;

if (isProduction) {
  // Production: serve static files from dist with SPA fallback
  serverInst = serve<WSData>({
    port,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;

      // Try file in dist
      let file = Bun.file(`dist${pathname}`);
      if (await file.exists()) return new Response(file);

      // Try directory index
      file = Bun.file(`dist${pathname}/index.html`);
      if (await file.exists()) return new Response(file);

      // SPA fallback
      return new Response(Bun.file("dist/index.html"));
    },
  });
} else {
  // Development: serve with HMR and static assets
  serverInst = serve<WSData>({
    port,
    routes: {
      "/api/login": async (request: Request) => {
        try {
          const { username: inputUsername, password } = LoginSchema.parse(await request.json());
          const apiBase = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);

          try {
            const params = new URLSearchParams({ email: inputUsername, password });
            const sessionRes = await fetch(`${apiBase}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
              body: params.toString()
            });

            if (!sessionRes.ok) return new Response("Invalid credentials", { status: 401 });

            // Traccar returns the user object on successful session creation
            const user = await sessionRes.json();
            // We'll use the canonical email/username returned by Traccar or fallback to input
            const identifier = user.email || inputUsername;

            const traccarToken = await tokenManager.getOrCreateTraccarPermanentToken(identifier, password);
            const token = sessionStore.createSession(identifier, traccarToken);
            return Response.json({ token });
          } catch {
            return new Response("Login failed", { status: 500 });
          }
        } catch (e) {
          if (e instanceof z.ZodError) {
            return new Response(`Invalid request: ${e.issues.map(err => err.message).join(", ")}`, { status: 400 });
          }
          console.error("Login route error:", e);
          return new Response("Login failed", { status: 500 });
        }
      },
      "/api/devices/:id/share": async (request: Request) => {
        const userInfo = await verifyTraccarSession(request);
        if (!userInfo) return new Response("Unauthorized", { status: 401 });

        try {
          const params = (request as unknown as { params: { id: string } }).params;
          const { id: deviceId } = DeviceIdSchema.parse(params);
          const { username } = UsernameSchema.parse(await request.json());

          // Verify ownership via Traccar
          if (!userInfo.ownedDeviceIds.includes(deviceId)) {
            return new Response("Forbidden: You do not own this device", { status: 403 });
          }

          db.query("INSERT OR REPLACE INTO device_shares (device_id, shared_with_username, shared_by_username) VALUES (?, ?, ?)")
            .run(deviceId, username, userInfo.username);

          return Response.json({ success: true });
        } catch (e) {
          return new Response("Invalid request", { status: 400 });
        }
      },
      "/api/devices/:id/share/:username": async (request: Request) => {
        const userInfo = await verifyTraccarSession(request);
        if (!userInfo) return new Response("Unauthorized", { status: 401 });

        try {
          const params = (request as unknown as { params: { id: string; username: string } }).params;
          const { id: deviceId, username: targetUsername } = z.object({
            id: z.coerce.number(),
            username: z.string().min(1)
          }).parse(params);

          // Verify ownership or self-removal
          const isOwner = userInfo.ownedDeviceIds.includes(deviceId);
          const isTarget = userInfo.username === targetUsername;

          if (!isOwner && !isTarget) {
            return new Response("Forbidden", { status: 403 });
          }

          db.query("DELETE FROM device_shares WHERE device_id = ? AND shared_with_username = ?")
            .run(deviceId, targetUsername);

          return Response.json({ success: true });
        } catch (e) {
          return new Response("Invalid request", { status: 400 });
        }
      },
      "/api/devices/shares": async (request: Request) => {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        const userInfo = await verifyTraccarSession(request);
        if (!userInfo) return new Response("Unauthorized", { status: 401 });

        try {
          // Get all shares created BY this user
          const allShares = db.query(
            `SELECT device_id, shared_with_username FROM device_shares
               WHERE shared_by_username = ?`
          ).all(userInfo.username) as { device_id: number; shared_with_username: string }[];

          // Filter to only owned devices and get device names from serverState
          const sharesList = allShares
            .filter(s => userInfo.ownedDeviceIds.includes(s.device_id))
            .map(s => ({
              deviceId: s.device_id,
              deviceName: serverState.devices[s.device_id]?.name ?? `Device ${s.device_id}`,
              sharedWith: s.shared_with_username
            }));

          return Response.json({ shares: sharesList });
        } catch (e) {
          return new Response("Invalid request", { status: 400 });
        }
      },
      "/api/ws": (request: Request, server: Server<WSData>) => {
        vlog(`[WS] Upgrade request received. Origin: ${request.headers.get("origin")}`);
        const upgraded = server.upgrade(request, {
          data: { username: null, traccarToken: null, allowedDeviceIds: new Set() }
        });
        vlog(`[WS] Upgrade result: ${upgraded}`);
        if (upgraded) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      },
      "/assets/**": Bun.file("src/assets"),
      "/*": indexHtml as never,
    },

    websocket: {
      async message(ws: ServerWebSocket<WSData>, message) {
        try {
          const data = ClientMessageSchema.parse(JSON.parse(message as string));

          if (data.type === "authenticate") {
            vlog(`[WS] Authenticating client with session token: ${data.token.substring(0, 10)}...`);

            const session = sessionStore.getSession(data.token);
            if (!session) {
              ws.send(JSON.stringify({ type: "error", message: "Session expired", requestId: null }));
              ws.close(1008, "Session expired");
              return;
            }

            const { username, traccarToken } = session;

            const apiBase = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);
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
            const ownedDeviceIds = new Set(devices.map(d => d.id));

            // Update server state with device metadata so getMetadata() computes correct rootIds
            serverState.handleDevices(devices);

            // Add shared devices
            const shared = db.query("SELECT device_id FROM device_shares WHERE shared_with_username = ?").all(username) as { device_id: number }[];
            const allowedDeviceIds = new Set([...ownedDeviceIds, ...shared.map(s => s.device_id)]);

            ws.data.username = username;
            ws.data.traccarToken = traccarToken;
            ws.data.allowedDeviceIds = allowedDeviceIds;

            vlog(`[WS] Authentication successful for ${username}. Devices: ${allowedDeviceIds.size}`);

            for (const id of allowedDeviceIds) {
              ws.subscribe(`device-${id}`);
            }

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
            const { activePoints: filteredPoints, events: filteredEvents } = collectDeviceData(Array.from(allowedDeviceIds).filter(id => rootIds.includes(id)), true, cutoff, entitiesWithOwner);

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
          } else if (ws.data.username && ws.data.traccarToken) {
            // RPC handlers
            const { type, payload, requestId } = data;

            const apiBase = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);

            const reqHeaders = {
              "Authorization": `Bearer ${ws.data.traccarToken}`,
              "Content-Type": "application/json",
              "Accept": "application/json"
            };

            try {
              if (type === "create_group") {
                const { name, emoji, memberDeviceIds } = payload;
                if (!memberDeviceIds.every((id: number) => ws.data.allowedDeviceIds.has(id))) {
                  ws.send(JSON.stringify({ type: "error", message: "Forbidden or invalid device IDs", requestId }));
                  return;
                }
                const res = await fetch(`${apiBase}/devices`, {
                  method: "POST",
                  headers: reqHeaders,
                  body: JSON.stringify({
                    name,
                    uniqueId: "group-" + Date.now(),
                    attributes: { emoji, memberDeviceIds: JSON.stringify(memberDeviceIds) }
                  })
                });
                if (!res.ok) throw new Error(await res.text());
                const device = TraccarDeviceSchema.parse(await res.json());
                serverState.handleDevices([device]);
                ws.send(JSON.stringify({ type: "create_success", device, requestId }));
              }
              else if (type === "update_device") {
                const { deviceId, updates } = payload;
                if (!ws.data.allowedDeviceIds.has(deviceId)) {
                  ws.send(JSON.stringify({ type: "error", message: "Forbidden", requestId }));
                  return;
                }
                const getRes = await fetch(`${apiBase}/devices/${deviceId}`, { headers: reqHeaders });
                if (!getRes.ok) throw new Error("Device not found");
                const current = await getRes.json();

                const attributes = { ...current.attributes };
                if (updates.emoji !== undefined) attributes['emoji'] = updates.emoji;
                if (updates.color !== undefined) attributes['color'] = updates.color;
                if (updates.motionProfile !== undefined) attributes['motionProfile'] = updates.motionProfile;
                // Note: updates for groups is handled via other RPCs or not explicitly in ClientMessageSchema payload for update_device but added for completeness if needed

                const putRes = await fetch(`${apiBase}/devices/${deviceId}`, {
                  method: "PUT",
                  headers: reqHeaders,
                  body: JSON.stringify({ ...current, name: updates.name || current.name, attributes })
                });
                if (!putRes.ok) throw new Error(await putRes.text());
                const updated = TraccarDeviceSchema.parse(await putRes.json());
                serverState.handleDevices([updated]);
                ws.send(JSON.stringify({ type: "update_success", deviceId, requestId }));
              }
              else if (type === "delete_group") {
                const { groupId } = payload;
                if (!ws.data.allowedDeviceIds.has(groupId)) {
                  ws.send(JSON.stringify({ type: "error", message: "Forbidden", requestId }));
                  return;
                }
                const res = await fetch(`${apiBase}/devices/${groupId}`, { method: "DELETE", headers: reqHeaders });
                if (!res.ok) throw new Error(await res.text());
                ws.send(JSON.stringify({ type: "delete_success", groupId, requestId }));
              }
              else if (type === "add_device_to_group" || type === "remove_device_from_group") {
                const { groupId, deviceId } = payload;
                if (!ws.data.allowedDeviceIds.has(groupId) || !ws.data.allowedDeviceIds.has(deviceId)) {
                  ws.send(JSON.stringify({ type: "error", message: "Forbidden", requestId }));
                  return;
                }
                const getRes = await fetch(`${apiBase}/devices/${groupId}`, { headers: reqHeaders });
                if (!getRes.ok) throw new Error("Group not found");
                const current = await getRes.json();

                let memberDeviceIds: number[] = current.attributes?.memberDeviceIds ? JSON.parse(current.attributes.memberDeviceIds) : [];
                if (type === "add_device_to_group") {
                  if (!memberDeviceIds.includes(deviceId)) memberDeviceIds.push(deviceId);
                } else {
                  memberDeviceIds = memberDeviceIds.filter(id => id !== deviceId);
                }

                const putRes = await fetch(`${apiBase}/devices/${groupId}`, {
                  method: "PUT",
                  headers: reqHeaders,
                  body: JSON.stringify({ ...current, attributes: { ...current.attributes, memberDeviceIds: JSON.stringify(memberDeviceIds) } })
                });
                if (!putRes.ok) throw new Error(await putRes.text());
                const updated = TraccarDeviceSchema.parse(await putRes.json());
                serverState.handleDevices([updated]);
                ws.send(JSON.stringify({ type: "update_success", deviceId: groupId, requestId }));
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              console.error(`[WS RPC Error] ${type}:`, errorMessage);
              ws.send(JSON.stringify({ type: "error", message: errorMessage, requestId }));
            }
          }
        } catch (e) {
          if (e instanceof z.ZodError) {
            ws.send(JSON.stringify({ type: "error", message: `Validation error: ${e.issues.map(err => err.message).join(", ")}`, requestId: null }));
          } else {
            console.error("Invalid WS message", e);
          }
        }
      },
      open(_ws: ServerWebSocket<WSData>) {
        vlog("[WS] Connection opened");
      },
      close(_ws: ServerWebSocket<WSData>) {
        vlog("[WS] Connection closed");
      }
    },
    development: {
      hmr: true,
      console: true,
    },
  });
}

// Start Traccar admin connection if config is ready
if (currentBaseUrl && currentToken) {
  initTraccarClient(serverInst, currentBaseUrl, config.traccarSecure, currentToken);
}

console.log(`🚀 Server running at http://localhost:${port}`);
