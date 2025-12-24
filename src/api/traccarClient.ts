// Traccar client utilities

export type TraccarAuth =
  | { type: "basic"; username: string; password: string }
  | { type: "token"; token: string };

export type TraccarClientOptions = {
  baseUrl: string; // e.g. "https://traccar.example.com/api"
  auth?: TraccarAuth;
  fetchImpl?: typeof fetch; // for testing or alternate runtimes
  defaultAccuracyMeters?: number; // if accuracy missing
};

export type NormalizedPosition = {
  lat: number;
  lon: number;
  accuracy: number; // meters
  timestamp: number; // epoch ms
  source?: string; // optional source tag (protocol/device)
  deviceId?: string | number; // optional explicit device identifier when available
  raw?: unknown; // original payload
};

function buildAuthHeader(auth?: TraccarAuth) {
  if (!auth) return undefined;
  if (auth.type === "basic") {
    const b = btoa(`${auth.username}:${auth.password}`);
    return `Basic ${b}`;
  }
  if (auth.type === "token") {
    return `Bearer ${auth.token}`;
  }
  return undefined;
}

function parseTimestampFromRecord(r: unknown): number | undefined {
  // Traccar may return a number of fields for times. Prefer `time` or `deviceTime` or `fixTime` etc.
  if (!r || typeof r !== "object") return undefined;
  const obj = r as Record<string, unknown>;
  const candidates = ["time", "timestamp", "deviceTime", "fixTime", "serverTime", "fixtime", "timeServer"];
  for (const k of candidates) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) return parsed;
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return undefined;
}

export function normalizePosition(raw: unknown, defaultAccuracy = 50): NormalizedPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const lat = typeof obj.latitude === "number" ? obj.latitude : typeof obj.lat === "number" ? obj.lat : typeof obj.latDeg === "number" ? obj.latDeg : typeof obj.y === "number" ? obj.y : undefined;
  const lon = typeof obj.longitude === "number" ? obj.longitude : typeof obj.lon === "number" ? obj.lon : typeof obj.lng === "number" ? obj.lng : typeof obj.x === "number" ? obj.x : undefined;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const ts = parseTimestampFromRecord(obj) ?? Date.now();
  const accuracyRaw = obj.accuracy ?? obj.precision;
  const accuracy = typeof accuracyRaw === "number" ? accuracyRaw : defaultAccuracy;
  const srcRaw = obj.protocol ?? obj.source ?? obj.deviceId;
  const source = typeof srcRaw === "string" ? srcRaw : typeof srcRaw === "number" ? String(srcRaw) : undefined;

  const deviceIdRaw = obj.deviceId ?? obj.device ?? obj.id;
  const deviceId = typeof deviceIdRaw === "number" || typeof deviceIdRaw === "string" ? deviceIdRaw : undefined;

  return {
    lat,
    lon,
    accuracy,
    timestamp: ts,
    source,
    deviceId,
    raw: obj,
  };
}

export async function fetchPositions(
  opts: TraccarClientOptions,
  deviceId: number | string,
  from: Date,
  to: Date | null = null,
  params: Record<string, string | number | boolean> = {}
): Promise<NormalizedPosition[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const paramsBase: Record<string, string> = {
    deviceId: String(deviceId),
    from: from.toISOString(),
  };
  if (to) paramsBase.to = to.toISOString();
  for (const [k, v] of Object.entries(params)) {
    paramsBase[k] = String(v);
  }
  const qs = new URLSearchParams(paramsBase).toString();
  const url = `${base}/positions?${qs}`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  const res = await fetcher(url, { method: "GET", headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar fetch failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const json: unknown = await res.json().catch(() => null);
  if (Array.isArray(json)) {
    return json.map((p) => normalizePosition(p, opts.defaultAccuracyMeters ?? 50)).filter(Boolean) as NormalizedPosition[];
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      return obj.data.map((p) => normalizePosition(p, opts.defaultAccuracyMeters ?? 50)).filter(Boolean) as NormalizedPosition[];
    }
  }
  throw new Error("Unexpected Traccar response format: expected JSON array");
}

export async function fetchDevices(opts: TraccarClientOptions): Promise<{ id: string | number; name?: string }[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/devices`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  const res = await fetcher(url, { method: "GET", headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar fetch failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const json: unknown = await res.json().catch(() => null);
  let arr: unknown[] = [];
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) arr = obj.data;
  }

  return arr
    .map((d) => {
      if (!d || typeof d !== "object") return null;
      const o = d as Record<string, any>;
      const id = o.id ?? o.deviceId ?? o.uniqueId ?? undefined;
      let name = o.name ?? o.uniqueId ?? o.deviceId ?? undefined;
      if (id == null) return null;
      // ensure a string name (fall back to id when missing)
      if (name == null) name = String(id);
      return { id, name: String(name) };
    })
    .filter(Boolean) as { id: string | number; name?: string }[];
}

export type RealtimeConnectOptions = {
  wsUrl?: string; // explicit WebSocket URL
  baseUrl?: string; // used to derive a default ws url when wsUrl omitted
  auth?: TraccarAuth;
  onPosition?: (p: NormalizedPosition) => void;
  onPositions?: (ps: NormalizedPosition[]) => void;
  onOpen?: () => void;
  onClose?: (ev?: CloseEvent) => void;
  onError?: (err: any) => void;
  autoReconnect?: boolean;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  defaultAccuracyMeters?: number;
};

export function connectRealtime(opts: RealtimeConnectOptions): { close: () => void; requestPositions?: (params?: { deviceId?: string | number; from?: Date; to?: Date; timeoutMs?: number; message?: object; }) => Promise<NormalizedPosition[]> } {
  let ws: WebSocket | null = null;
  let destroyed = false;
  let reconnectDelay = opts.reconnectInitialMs ?? 1000;

  type PendingRequest = { resolve: (ps: NormalizedPosition[]) => void; reject: (err: any) => void; timeoutId: ReturnType<typeof setTimeout>; matcher: (ps: NormalizedPosition[]) => boolean };
  const pendingRequests: PendingRequest[] = [];

  function buildWsUrl() {
    if (opts.wsUrl) return opts.wsUrl;
    if (opts.baseUrl) return opts.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/api/socket";
    return undefined;
  }

  function attachSocket() {
    if (destroyed) return;
    const base = buildWsUrl();
    if (!base) {
      // No URL configured — do not attempt to connect.
      opts.onError?.(new Error("No WebSocket URL provided; not connecting."));
      return;
    }

    let wsUrl = base;
    // append token if provided
    if (opts.auth && opts.auth.type === "token") {
      const sep = wsUrl.includes("?") ? "&" : "?";
      wsUrl = `${wsUrl}${sep}token=${encodeURIComponent(opts.auth.token)}`;
    } else if (typeof (opts.auth as any)?.token === "string") {
      const sep = wsUrl.includes("?") ? "&" : "?";
      wsUrl = `${wsUrl}${sep}token=${encodeURIComponent((opts.auth as any).token)}`;
    }

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      opts.onError?.(e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = opts.reconnectInitialMs ?? 1000;
      opts.onOpen?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        const positions = extractPositionsFromMessage(raw, opts.defaultAccuracyMeters ?? 50);
        if (positions.length > 0) {
          for (const p of positions) opts.onPosition?.(p);
          opts.onPositions?.(positions);

          // resolve any pending requests that match
          for (let i = pendingRequests.length - 1; i >= 0; i--) {
            try {
              const pr = pendingRequests[i];
              if (pr && pr.matcher(positions)) {
                clearTimeout(pr.timeoutId);
                pr.resolve(positions);
                pendingRequests.splice(i, 1);
              }
            } catch (e) {
              // ignore matcher errors
            }
          }
        }
      } catch (e) {
        // ignore parse errors but notify
        opts.onError?.(e);
      }
    };

    ws.onclose = (ev) => {
      ws = null;
      opts.onClose?.(ev);
      if (opts.autoReconnect !== false) scheduleReconnect();
    };

    ws.onerror = (ev) => {
      opts.onError?.(ev);
    };
  }

  function scheduleReconnect() {
    if (destroyed) return;
    setTimeout(() => {
      if (destroyed) return;
      attachSocket();
      reconnectDelay = Math.min((opts.reconnectMaxMs ?? 30_000), reconnectDelay * 2);
    }, reconnectDelay);
  }

  function requestPositions(params: { deviceId?: string | number; from?: Date; to?: Date; timeoutMs?: number; message?: object } = {}): Promise<NormalizedPosition[]> {
    return new Promise((resolve) => {
      if (!ws) {
        resolve([]);
        return;
      }

      const message = params.message ?? {
        action: "getPositions",
        deviceId: params.deviceId,
        from: params.from ? params.from.toISOString() : undefined,
        to: params.to ? params.to.toISOString() : undefined,
      };

      try {
        ws.send(JSON.stringify(message));
      } catch (e) {
        // if send fails, just resolve empty so caller can fallback
        resolve([]);
        return;
      }

      const timeoutMs = params.timeoutMs ?? 2000;
      const timeoutId = setTimeout(() => {
        // timed out — resolve with empty array
        const idx = pendingRequests.findIndex((p) => p.timeoutId === timeoutId);
        if (idx >= 0) pendingRequests.splice(idx, 1);
        resolve([]);
      }, timeoutMs);

      const matcher = (positions: NormalizedPosition[]) => {
        if (params.deviceId != null) return positions.some((p) => String(p.deviceId) === String(params.deviceId));
        if (params.from) return positions.some((p) => p.timestamp >= (params.from?.getTime() ?? 0));
        return positions.length > 0;
      };

      pendingRequests.push({ resolve, reject: () => {}, timeoutId, matcher });
    });
  }

  attachSocket();

  return {
    close() {
      destroyed = true;
      try {
        ws?.close();
      } catch (e) {
        /* ignore */
      }
      ws = null;
    },
    requestPositions,
  };
}

export function extractPositionsFromMessage(raw: unknown, defaultAccuracy = 50): NormalizedPosition[] {
  const out: NormalizedPosition[] = [];

  const visited = new WeakSet();

  function walk(node: any) {
    if (!node) return;
    if (typeof node === "object") {
      if (visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
        return;
      }

      // quick attempt: if this object looks like a position, normalize it
      const tryNorm = normalizePosition(node, defaultAccuracy);
      if (tryNorm) {
        out.push(tryNorm);
        return;
      }
      // common wrappers in Traccar messages
      for (const k of ["positions", "data", "payload", "body", "message"]) {
        if (k in node) walk((node as any)[k]);
      }
      // otherwise traverse properties
      for (const v of Object.values(node)) walk(v);
    }
  }

  walk(raw);
  return out;
}

export default {
  normalizePosition,
  fetchPositions,
  connectRealtime,
  extractPositionsFromMessage,
};
