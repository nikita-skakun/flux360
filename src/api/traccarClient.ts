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
  deviceId: number;
  timestamp: number; // epoch ms
  lat: number;
  lon: number;
  accuracy: number; // meters
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

export function normalizePosition(raw: unknown): NormalizedPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const lat = typeof obj.latitude === "number" ? obj.latitude : undefined;
  const lon = typeof obj.longitude === "number" ? obj.longitude : undefined;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const ts = typeof obj.fixTime === "string" ? Date.parse(obj.fixTime) : undefined;
  if (typeof ts !== "number" || Number.isNaN(ts)) return null;

  const deviceId = typeof obj.id === "number" ? obj.deviceId : undefined;
  if (typeof deviceId !== "number") return null;

  return {
    deviceId,
    timestamp: ts,
    lat,
    lon,
    accuracy: typeof obj.accuracy === "number" ? obj.accuracy : 100,
  } as NormalizedPosition;
}

async function performGet(fetcher: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetcher(url, { method: "GET", headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Traccar fetch failed: ${res.status} ${res.statusText} - ${body}`);
  }
  return await res.json().catch(() => null);
}

export async function fetchPositions(
  opts: TraccarClientOptions,
  deviceId: number,
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

  const json: unknown = await performGet(fetcher, url, headers);
  if (Array.isArray(json)) {
    return json.map((p) => normalizePosition(p)).filter(Boolean) as NormalizedPosition[];
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      return obj.data.map((p) => normalizePosition(p)).filter(Boolean) as NormalizedPosition[];
    }
  }
  throw new Error("Unexpected Traccar response format: expected JSON array");
}

export async function fetchDevices(opts: TraccarClientOptions): Promise<{ id: number; name: string; emoji: string }[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  let url = `${base}/devices`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  const json: unknown = await performGet(fetcher, url, headers);
  let arr: unknown[] = [];
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) arr = obj.data;
  }

  return arr.flatMap((d) => {
    if (!d || typeof d !== "object") return [];
    const o = d as Record<string, unknown>;

    const idRaw = o.id;
    if (typeof idRaw !== "number") return [];
    const id = idRaw as number;

    const nameRaw = o.name ?? o.uniqueId ?? id;
    const name = String(nameRaw);

    let emoji: string;
    if (o.attributes && typeof (o.attributes as any).emoji === "string") emoji = (o.attributes as any).emoji;
    else emoji = name.toUpperCase().charAt(0);

    return [{ id, name, emoji }];
  });
}

export type RealtimeConnectOptions = {
  wsUrl?: string; // explicit WebSocket URL
  baseUrl?: string; // used to derive a default ws url when wsUrl omitted
  auth?: TraccarAuth;
  onPosition?: (p: NormalizedPosition) => void;
  onPositions?: (ps: NormalizedPosition[]) => void;
  onOpen?: () => void;
  onClose?: (ev?: CloseEvent) => void;
  onError?: (err: unknown) => void;
  autoReconnect: boolean;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
};

export function connectRealtime(opts: RealtimeConnectOptions): { close: () => void; requestPositions: (params: { deviceId: number; from?: Date; to?: Date; timeoutMs?: number; message?: object; }) => Promise<NormalizedPosition[]> } {
  let ws: WebSocket | null = null;
  let destroyed = false;
  let reconnectDelay = opts.reconnectInitialMs ?? 1000;

  type PendingRequest = { resolve: (ps: NormalizedPosition[]) => void; reject: (err: unknown) => void; timeoutId: ReturnType<typeof setTimeout>; matcher: (ps: NormalizedPosition[]) => boolean };
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
        const positions = extractPositionsFromMessage(raw);
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
            } catch (e) { }
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

  function requestPositions(params: { deviceId: number; from?: Date; to?: Date; timeoutMs?: number; message?: object }): Promise<NormalizedPosition[]> {
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

      pendingRequests.push({ resolve, reject: () => { }, timeoutId, matcher: (ps: NormalizedPosition[]) => ps.some((p) => p.deviceId === params.deviceId) });
    });
  }

  attachSocket();

  return {
    close() {
      destroyed = true;
      try {
        ws?.close();
      } catch (e) { }
      ws = null;
    },
    requestPositions,
  };
}

export function extractPositionsFromMessage(raw: unknown): NormalizedPosition[] {
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
      const tryNorm = normalizePosition(node);
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
