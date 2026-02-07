import type { TraccarClientOptions } from "./httpUtils";
import { performGet, buildAuthHeader } from "./httpUtils";

export type NormalizedPosition = {
  device: number;
  timestamp: number; // epoch ms
  lat: number;
  lon: number;
  accuracy: number; // meters
};

export function normalizePosition(raw: unknown): NormalizedPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const lat = typeof obj["latitude"] === "number" ? obj["latitude"] : undefined;
  const lon = typeof obj["longitude"] === "number" ? obj["longitude"] : undefined;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const ts = typeof obj["fixTime"] === "string" ? Date.parse(obj["fixTime"]) : undefined;
  if (typeof ts !== "number" || Number.isNaN(ts)) return null;

  const deviceId = typeof obj["deviceId"] === "number" ? obj["deviceId"] : undefined;
  if (typeof deviceId !== "number") return null;

  return {
    device: deviceId,
    timestamp: ts,
    lat,
    lon,
    accuracy: typeof obj["accuracy"] === "number" ? obj["accuracy"] : 100,
  } as NormalizedPosition;
}

export async function fetchPositions(
  opts: TraccarClientOptions,
  device: number,
  from: Date,
  to: Date | null = null,
  params: Record<string, string | number | boolean> = {}
): Promise<NormalizedPosition[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const protocol = opts.secure ? 'https' : 'http';
  const base = `${protocol}://${opts.baseUrl}/api`;
  const paramsBase: Record<string, string> = {
    deviceId: String(device),
    from: from.toISOString(),
  };
  if (to) paramsBase["to"] = to.toISOString();
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
    if (Array.isArray(obj["data"])) {
      return obj["data"].map((p) => normalizePosition(p)).filter(Boolean) as NormalizedPosition[];
    }
  }
  throw new Error("Unexpected Traccar response format: expected JSON array");
}