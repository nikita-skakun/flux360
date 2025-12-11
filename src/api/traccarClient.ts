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
  raw?: any; // original payload
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

function parseTimestampFromRecord(r: any): number | undefined {
  // Traccar may return a number of fields for times. Prefer `time` or `deviceTime` or `fixTime` etc.
  const candidates = ["time", "timestamp", "deviceTime", "fixTime", "serverTime", "fixtime", "timeServer"];
  for (const k of candidates) {
    if (r[k] != null) {
      // numeric (ms) or ISO string
      if (typeof r[k] === "number") return r[k];
      const parsed = Date.parse(r[k]);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  // older Traccar might use `deviceId` and timing in other fields; fallback to `id` as ms (unlikely)
  return undefined;
}

export function normalizePosition(raw: any, defaultAccuracy = 50): NormalizedPosition | null {
  if (!raw) return null;
  const lat = raw.latitude ?? raw.lat ?? raw.latDeg ?? raw.y;
  const lon = raw.longitude ?? raw.lon ?? raw.lng ?? raw.x;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const ts = parseTimestampFromRecord(raw) ?? Date.now();
  const accuracy = raw.accuracy ?? raw.precision ?? defaultAccuracy;
  const source = raw.protocol ?? raw.source ?? `${raw.deviceId ?? "unknown"}`;

  return {
    lat,
    lon,
    accuracy: typeof accuracy === "number" ? accuracy : defaultAccuracy,
    timestamp: ts,
    source,
    raw,
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
  const q: Record<string, string> = {
    deviceId: String(deviceId),
    from: from.toISOString(),
    ...params,
  };
  if (to) q.to = to.toISOString();
  const qs = new URLSearchParams(q as any).toString();
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

  const json = await res.json().catch(() => null);
  if (!Array.isArray(json)) {
    // Some Traccar versions return an object { data: [...] }
    if (json && Array.isArray(json.data)) return json.data.map((p: any) => normalizePosition(p, opts.defaultAccuracyMeters ?? 50)).filter(Boolean) as NormalizedPosition[];
    throw new Error("Unexpected Traccar response format: expected JSON array");
  }

  return json.map((p: any) => normalizePosition(p, opts.defaultAccuracyMeters ?? 50)).filter(Boolean) as NormalizedPosition[];
}

export default {
  normalizePosition,
  fetchPositions,
};
