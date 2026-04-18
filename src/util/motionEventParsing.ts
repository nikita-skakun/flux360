import { z } from "zod";

function normalizePointArray(arr: unknown): unknown {
  if (!Array.isArray(arr)) return arr;

  return arr.map((entry): unknown => {
    if (!entry || typeof entry !== "object") return entry;

    const point = entry as Record<string, unknown>;
    if (Array.isArray(point["geo"])) return entry;

    const lon = point["lon"];
    const lat = point["lat"];
    if (typeof lon !== "number" || typeof lat !== "number") return entry;

    const { lon: lonVal, lat: latVal, ...rest } = point;
    return { ...rest, geo: [lonVal, latVal] };
  });
}

export function parseDecodedMotionEvent<T>(
  decoded: unknown,
  schema: z.ZodType<T>
): T | null {
  const evObj = decoded as Record<string, unknown>;
  const normalizedEv = {
    ...evObj,
    path: normalizePointArray(evObj["path"]),
    outliers: normalizePointArray(evObj["outliers"]),
  };

  const result = schema.safeParse(normalizedEv);
  return result.success ? result.data : null;
}
