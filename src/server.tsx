import { serve } from "bun";
import indexHtml from "./index.html";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env["PORT"] || 3000);

interface Config {
  traccarBaseUrl: string;
  traccarSecure: boolean;
  maptilerApiKey: string;
  traccarApiToken: string;
}

interface WSData {
  username: string | null;
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
import { ServerState } from "./server/serverState";
import { TraccarAdminClient } from "./server/traccarClient";
import { db } from "./server/db";

const serverState = new ServerState();

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

let config: Config;
try {
  config = await configFile.json();
} catch (e) {
  console.error("Error: config.json is not valid JSON.");
  process.exit(1);
}

const requiredFields: (keyof Config)[] = ["traccarBaseUrl", "maptilerApiKey", "traccarApiToken"];

const missingFields = requiredFields.filter(field => !config[field]);

if (missingFields.length > 0) {
  console.error(`Error: Mandatory configuration fields are missing in config.json: ${missingFields.join(", ")}`);
  process.exit(1);
}

async function verifyTraccarSession(request: Request): Promise<{ username: string; ownedDeviceIds: number[] } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  try {
    let baseUrl = config.traccarBaseUrl.trim();
    let host = baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");

    const hasApi = host.endsWith("/api") || host.includes("/api/");
    if (hasApi) {
      host = host.replace(/\/api\/?.*$/, "");
    }

    const protocol = config.traccarSecure ? "https" : "http";
    const base = `${protocol}://${host}`;

    // 1. Try to extract username from Basic Auth header
    let username: string | null = null;
    const [authType, credentials] = authHeader.split(" ");
    if (authType === "Basic" && credentials) {
      try {
        const decoded = Buffer.from(credentials, "base64").toString("utf-8");
        const parts = decoded.split(":");
        if (parts.length >= 1 && parts[0]) username = parts[0];
      } catch (e) {
        console.warn("[verifyTraccarSession] Failed to decode Basic Auth header");
      }
    }

    // 2. Fetch devices to verify credentials and get ownership
    const devicesUrl = `${base}/api/devices`;
    const devicesRes = await fetch(devicesUrl, {
      headers: { "Authorization": authHeader, "Accept": "application/json" }
    });

    if (!devicesRes.ok) {
      console.error(`[verifyTraccarSession] Auth check failed at ${devicesUrl}: ${devicesRes.status} ${devicesRes.statusText}`);
      return null;
    }

    const devices = await devicesRes.json() as { id: number }[];
    const ownedDeviceIds = devices.map(d => d.id);

    // 3. Fallback for username if not using Basic Auth
    if (!username) {
      console.log(`[verifyTraccarSession] Not Basic Auth, attempting /api/session for username...`);
      const sessionRes = await fetch(`${base}/api/session`, {
        headers: { "Authorization": authHeader, "Accept": "application/json" }
      });
      if (sessionRes.ok) {
        const user = await sessionRes.json();
        username = user.email || user.name || "unknown";
      } else {
        username = "token_user"; 
      }
    }

    return { username: username || "unknown", ownedDeviceIds };
  } catch (e) {
    console.error(`[verifyTraccarSession] Network error during verification:`, e);
    return null;
  }
}

// Config is validated and ready
const currentBaseUrl = config.traccarBaseUrl;
const currentToken = config.traccarApiToken;

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
      if (pathname === "/api/config") {
        return Response.json({
          traccarBaseUrl: config.traccarBaseUrl,
          traccarSecure: config.traccarSecure,
        });
      }

      if (pathname === "/api/config/maptiler") {
        if (!(await verifyTraccarSession(request))) {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json({
          maptilerApiKey: config.maptilerApiKey,
        });
      }

      return new Response(Bun.file("dist/index.html"));
    },
  });
} else {
  // Development: serve with HMR and static assets
  serverInst = serve<WSData>({
    port,
    routes: {
      "/api/config": () => {
        return Response.json({
          traccarBaseUrl: config.traccarBaseUrl,
          traccarSecure: config.traccarSecure,
        });
      },
      "/api/config/maptiler": async (request: Request) => {
        const userInfo = await verifyTraccarSession(request);
        if (!userInfo) return new Response("Unauthorized", { status: 401 });
        return Response.json({ maptilerApiKey: config.maptilerApiKey });
      },
      "/api/devices/:id/share": async (request: Request) => {
        const userInfo = await verifyTraccarSession(request);
        if (!userInfo) return new Response("Unauthorized", { status: 401 });
        
        try {
          const params = (request as any).params as { id: string };
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
          const params = (request as any).params as { id: string; username: string };
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
          data: { username: null, allowedDeviceIds: new Set(), ownedDeviceIds: new Set() }
        });
        if (upgraded) return new Response();
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
            console.log(`[WS] Authenticating client with token: ${data.token.substring(0, 10)}...`);
            // Ensure token is formatted as a proper Authorization header
            const authHeader = data.token.startsWith("Basic ") || data.token.startsWith("Bearer ") ? data.token : `Basic ${data.token}`;
            const userInfo = await verifyTraccarSession(new Request("http://localhost", { headers: { "Authorization": authHeader } }));
            
            if (userInfo) {
              console.log(`[WS] Authentication successful for ${userInfo.username}`);
              ws.data.username = userInfo.username;
              ws.data.ownedDeviceIds = new Set(userInfo.ownedDeviceIds);
              
              // Add shared devices
              const shared = db.query("SELECT device_id FROM device_shares WHERE shared_with_username = ?").all(userInfo.username) as { device_id: number }[];
              ws.data.allowedDeviceIds = new Set([...userInfo.ownedDeviceIds, ...shared.map(s => s.device_id)]);
              console.log(`[WS] User ${userInfo.username} allowed device count: ${ws.data.allowedDeviceIds.size}`);

              // Subscribe to individual topics
              for (const id of ws.data.allowedDeviceIds) {
                ws.subscribe(`device-${id}`);
              }

              // Send initial state filtered
              const filteredDevices: Record<number, any> = {};
              const filteredSnapshots: Record<number, any> = {};
              const filteredEvents: Record<number, any> = {};
              
              for (const id of ws.data.allowedDeviceIds) {
                if (serverState.devices[id]) {
                  filteredDevices[id] = { 
                    ...serverState.devices[id], 
                    isOwner: ws.data.ownedDeviceIds.has(id) 
                  };
                }
                if (serverState.engineSnapshotsByDevice[id]) {
                  filteredSnapshots[id] = serverState.engineSnapshotsByDevice[id];
                }
                if (serverState.eventsByDevice[id]) {
                  filteredEvents[id] = serverState.eventsByDevice[id];
                }
              }

              ws.send(JSON.stringify({
                type: "initial_state",
                payload: {
                  devices: filteredDevices,
                  groups: serverState.groups.filter(g => ws.data.allowedDeviceIds.has(g.id) || g.memberDeviceIds.some(mid => ws.data.allowedDeviceIds.has(mid))),
                  engineSnapshotsByDevice: filteredSnapshots,
                  eventsByDevice: filteredEvents
                }
              }));
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
