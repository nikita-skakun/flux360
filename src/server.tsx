import { serve } from "bun";
import indexHtml from "./index.html";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env["PORT"] || 3000);

interface Config {
  traccarBaseUrl: string;
  traccarSecure: boolean;
  maptilerApiKey: string;
  traccarApiToken: string;
  historyDays: number;
}

interface WSData {
  username: string | null;
  traccarToken: string | null;
  allowedDeviceIds: Set<number>;
  ownedDeviceIds: Set<number>;
}

// Validate mandatory configuration on startup
const configFile = Bun.file("config.json");
if (!(await configFile.exists())) {
  console.error("Error: config.json is missing. Please create it based on config.sample.json.");
  process.exit(1);
}

// Application state and Traccar Client
import { db } from "./server/db";
import { getTraccarApiBase } from "./server/traccarUrlUtils";
import { ServerState } from "./server/serverState";
import { TraccarAdminClient } from "./server/traccarClient";

let config: Config;
try {
  config = await configFile.json();
} catch (e) {
  console.error("Error: config.json is not valid JSON.");
  process.exit(1);
}

const requiredFields: (keyof Config)[] = ["traccarBaseUrl", "maptilerApiKey", "traccarApiToken", "historyDays"];

const missingFields = requiredFields.filter(field => !config[field]);

if (missingFields.length > 0) {
  console.error(`Error: Mandatory configuration fields are missing in config.json: ${missingFields.join(", ")}`);
  process.exit(1);
}

const serverState = new ServerState(config.historyDays);

// Helper to broadcast state to specific device topics
function broadcastUpdate(server: import("bun").Server<WSData>) {
  for (const deviceId of Object.keys(serverState.engineSnapshotsByDevice)) {
    const id = parseInt(deviceId);
    server.publish(`device-${id}`, JSON.stringify({
      type: "positions_update",
      payload: {
        snapshots: { [id]: serverState.engineSnapshotsByDevice[id] },
        events: { [id]: serverState.eventsByDevice[id] ?? [] }
      }
    }));
  }
}

// Helper to start/restart admin client
let traccarClient: TraccarAdminClient | null = null;
function initTraccarClient(server: import("bun").Server<WSData>, baseUrl: string, secure: boolean, token: string) {
  if (traccarClient) traccarClient.close();

  traccarClient = new TraccarAdminClient(baseUrl, secure, token, {
    onDevicesReceived: (devices) => {
      serverState.handleDevices(devices);

      // Broadcast global device changes to all relevant device topics.
      // Individual clients only receive updates for devices they are subscribed to.
      for (const deviceId of Object.keys(serverState.devices)) {
        const id = parseInt(deviceId);
        const device = serverState.devices[id];
        server.publish(`device-${id}`, JSON.stringify({
          type: "config_update",
          payload: {
            devices: { [id]: { ...device, isOwner: false } }, // logic for isOwner happens at subscription time
            groups: serverState.groups.filter(g => g.id === id || g.memberDeviceIds.includes(id))
          }
        }));
      }
    },
    onPositionsReceived: (positions) => {
      const result = serverState.handlePositions(positions);
      if (result) broadcastUpdate(server);
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

    const devicesRes = await fetch(`${base}/api/devices`, {
      headers: { "Authorization": `Bearer ${session.traccarToken}`, "Accept": "application/json" }
    });

    if (!devicesRes.ok) return null;

    const devices = await devicesRes.json() as { id: number }[];
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

let serverInst: import("bun").Server<WSData>;

if (isProduction) {
  // Production: serve static files from dist with SPA fallback
  serverInst = serve<WSData>({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Try file in dist
      const filePath = `dist${pathname}`;
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }

      // Try directory index
      const dirPath = `dist${pathname}/index.html`;
      const dirFile = Bun.file(dirPath);
      if (await dirFile.exists()) {
        return new Response(dirFile);
      }

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
          const { email, password } = await request.json() as { email: string; password: string };
          if (!email || !password) {
            return new Response("Email and password required", { status: 400 });
          }

          const apiBase = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);
          const sessionUrl = `${apiBase}/session`;

          let username = email;
          try {
            const params = new URLSearchParams({ email, password });
            const sessionRes = await fetch(sessionUrl, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
              body: params.toString()
            });

            if (!sessionRes.ok) {
              return new Response("Invalid credentials", { status: 401 });
            }

            const user = await sessionRes.json();
            username = user.email || user.name || email;
          } catch {
            return new Response("Login failed", { status: 500 });
          }

          const traccarToken = await tokenManager.getOrCreateTraccarPermanentToken(username, password);
          const token = sessionStore.createSession(username, traccarToken);

          return Response.json({
            success: true,
            token,
            username
          });
        } catch (e) {
          console.error("Login route error:", e);
          return new Response("Login failed", { status: 500 });
        }
      },
      "/api/devices/:id/share": async (request: Request) => {
        const userInfo = await verifyTraccarSession(request);
        if (!userInfo) return new Response("Unauthorized", { status: 401 });

        try {
          const params = (request as unknown as { params: { id: string } }).params;
          const deviceId = parseInt(params.id);
          const { username } = await request.json() as { username: string };

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
          const deviceId = parseInt(params.id);
          const targetUsername = params.username;

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
      "/api/ws": (request: Request, server: import("bun").Server<WSData>) => {
        const upgraded = server.upgrade(request, {
          data: { username: null, traccarToken: null, allowedDeviceIds: new Set(), ownedDeviceIds: new Set() }
        });
        if (upgraded) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      },
      "/assets/**": Bun.file("src/assets"),
      "/*": indexHtml as never,
    },

    websocket: {
      async message(ws: import("bun").ServerWebSocket<WSData>, message) {
        try {
          const data = JSON.parse(message as string);
          if (data.type === "authenticate" && data.token) {
            console.log(`[WS] Authenticating client with session token: ${data.token.substring(0, 10)}...`);

            const session = sessionStore.getSession(data.token);
            if (!session) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid session" }));
              return;
            }

            const { username, traccarToken } = session;

            const apiBase = getTraccarApiBase(config.traccarBaseUrl, config.traccarSecure);
            const devicesUrl = `${apiBase}/devices`;

            const devicesRes = await fetch(devicesUrl, {
              headers: { "Authorization": `Bearer ${traccarToken}`, "Accept": "application/json" }
            });

            if (!devicesRes.ok) {
              ws.send(JSON.stringify({ type: "error", message: "Session expired" }));
              sessionStore.deleteSession(data.token);
              return;
            }

            const devices = await devicesRes.json() as { id: number }[];
            const ownedDeviceIds = new Set(devices.map(d => d.id));

            // Add shared devices
            const shared = db.query("SELECT device_id FROM device_shares WHERE shared_with_username = ?").all(username) as { device_id: number }[];
            const allowedDeviceIds = new Set([...ownedDeviceIds, ...shared.map(s => s.device_id)]);

            ws.data.username = username;
            ws.data.traccarToken = traccarToken;
            ws.data.ownedDeviceIds = ownedDeviceIds;
            ws.data.allowedDeviceIds = allowedDeviceIds;

            console.log(`[WS] Authentication successful for ${username}. Devices: ${allowedDeviceIds.size}`);

            for (const id of allowedDeviceIds) {
              ws.subscribe(`device-${id}`);
            }

            const filteredDevices: Record<number, import("./types/index").AppDevice> = {};
            const filteredSnapshots: Record<number, import("./types/index").DevicePoint[]> = {};
            const filteredEvents: Record<number, import("./types/index").EngineEvent[]> = {};

            for (const id of allowedDeviceIds) {
              if (serverState.devices[id]) {
                filteredDevices[id] = {
                  ...serverState.devices[id],
                  isOwner: ownedDeviceIds.has(id)
                };
              }
              if (serverState.engineSnapshotsByDevice[id]) {
                filteredSnapshots[id] = serverState.engineSnapshotsByDevice[id];
              }
              if (serverState.eventsByDevice[id]) {
                filteredEvents[id] = serverState.eventsByDevice[id];
              }
            }

            const payloadObj = {
              type: "initial_state",
              payload: {
                devices: filteredDevices,
                groups: serverState.groups.filter(g => allowedDeviceIds.has(g.id) || g.memberDeviceIds.some(mid => allowedDeviceIds.has(mid))),
                engineSnapshotsByDevice: filteredSnapshots,
                eventsByDevice: filteredEvents,
                maptilerApiKey: config.maptilerApiKey
              }
            };

            const payloadStr = JSON.stringify(payloadObj);
            console.log(`[WS] Sending 'initial_state' of size: ${payloadStr.length} bytes for ${username}`);
            ws.send(payloadStr);
          } else if (data.requestId && ws.data.username && ws.data.traccarToken) {
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
                  ws.send(JSON.stringify({ type: "error", message: "Forbidden", requestId }));
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
                const device = await res.json();
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
                if (updates.emoji !== undefined) attributes.emoji = updates.emoji;
                if (updates.color !== undefined) attributes.color = updates.color;
                if (updates.motionProfile !== undefined) attributes.motionProfile = updates.motionProfile;
                if (updates.memberDeviceIds !== undefined) attributes.memberDeviceIds = JSON.stringify(updates.memberDeviceIds);

                const putRes = await fetch(`${apiBase}/devices/${deviceId}`, {
                  method: "PUT",
                  headers: reqHeaders,
                  body: JSON.stringify({ ...current, name: updates.name || current.name, attributes })
                });
                if (!putRes.ok) throw new Error(await putRes.text());
                const updated = await putRes.json();
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
                const updated = await putRes.json();
                serverState.handleDevices([updated]);
                ws.send(JSON.stringify({ type: "update_success", deviceId: groupId, requestId }));
              } else {
                ws.send(JSON.stringify({ type: "error", message: "Unknown RPC type", requestId }));
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              console.error(`[WS RPC Error] ${type}:`, errorMessage);
              ws.send(JSON.stringify({ type: "error", message: errorMessage, requestId }));
            }
          }
        } catch (e) {
          console.error("Invalid WS message", e);
        }
      },
      open(_ws: import("bun").ServerWebSocket<WSData>) {
      },
      close(ws: import("bun").ServerWebSocket<WSData>) {
        if (ws.data.allowedDeviceIds) {
          for (const id of ws.data.allowedDeviceIds) {
            ws.unsubscribe(`device-${id}`);
          }
        }
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
