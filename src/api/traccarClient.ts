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

export default {
  normalizePosition,
  fetchPositions,
};
