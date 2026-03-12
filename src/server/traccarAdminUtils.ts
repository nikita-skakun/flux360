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

export function extractPositionsFromMessage(raw: unknown): NormalizedPosition[] {
  const out: NormalizedPosition[] = [];
  const visited = new WeakSet();

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }

    const tryNorm = normalizePosition(node);
    if (tryNorm) {
      out.push(tryNorm);
      return;
    }
    const obj = node as Record<string, unknown>;
    const searchKeys = ["positions", "data", "payload", "body", "message"] as const;
    for (const k of searchKeys) {
      if (k in obj) walk(obj[k]);
    }
    for (const v of Object.values(obj)) walk(v);
  }

  walk(raw);
  return out;
}
