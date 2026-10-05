import { z } from "zod";
import type { EngineEvent } from "@/types";

const toLonLat = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;

  return value.map((entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;

    const point = entry as Record<string, unknown>;
    const geo = point["geo"];
    if (!Array.isArray(geo) || geo.length < 2) return entry;

    const rest = Object.fromEntries(Object.entries(point).filter(([key]) => key !== "geo"));
    return { ...rest, lon: geo[0] as number, lat: geo[1] as number };
  });
};

const toGeo = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;

  return value.map((entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") return entry;

    const point = entry as Record<string, unknown>;
    if (Array.isArray(point["geo"])) return entry;

    const lon = point["lon"];
    const lat = point["lat"];
    if (typeof lon !== "number" || typeof lat !== "number") return entry;

    const { lon: lonValue, lat: latValue, ...rest } = point;
    return { ...rest, geo: [lonValue, latValue] };
  });
};

export function parseDecodedMotionEvent<T>(decoded: unknown, schema: z.ZodType<T>): T | null {
  const ev = (decoded as Record<string, unknown>)["ev"] as Record<string, unknown>;

  const result = schema.safeParse({
    ...ev,
    path: toGeo(ev["path"]),
    outliers: toGeo(ev["outliers"]),
  });

  return result.success ? result.data : null;
}

export function toWireEvent(event: EngineEvent): unknown {
  const round = (value: unknown): unknown => {
    if (typeof value === "number") return Math.round(value * 100) / 100;
    if (Array.isArray(value)) return value.map(round);
    if (value && typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(objectValue).map(([key, item]) => [key, round(item)]));
    }
    return value;
  };

  const rounded = round(event) as Record<string, unknown>;
  return {
    ...rounded,
    path: toLonLat(rounded["path"]),
    outliers: toLonLat(rounded["outliers"]),
  };
}