import { performRequest, buildAuthHeader, type TraccarClientOptions } from "./httpUtils";
import type { NormalizedPosition } from "@/types";

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
    geo: [lon, lat],
    accuracy: typeof obj["accuracy"] === "number" ? obj["accuracy"] : 100,
  };
}

export async function fetchPositions(
  opts: TraccarClientOptions,
  device: number,
  from: Date,
  to: Date | null = null,
  params: Record<string, string> = {}
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
    paramsBase[k] = v;
  }

  const qs = new URLSearchParams(paramsBase).toString();
  const url = `${base}/positions?${qs}`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  const authHeader = buildAuthHeader(opts.auth);
  if (authHeader) headers["Authorization"] = authHeader;

  const data = await performRequest<unknown>(fetcher, url, "GET", headers);
  if (Array.isArray(data)) {
    return data.map((p) => normalizePosition(p)).filter((p): p is NormalizedPosition => p !== null);
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj["data"])) {
      return (obj["data"] as unknown[]).map((p) => normalizePosition(p)).filter((p): p is NormalizedPosition => p !== null);
    }
  }
  throw new Error("Unexpected Traccar response format: expected JSON array");
}