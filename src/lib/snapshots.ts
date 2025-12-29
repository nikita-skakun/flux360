import type { DevicePoint } from "@/ui/types";

function pointKey(p: DevicePoint) {
  return `${p.device}:${p.timestamp}:${p.lat}:${p.lon}`;
}

export function mergeSnapshots(prev: DevicePoint[], next: DevicePoint[]) {
  const map = new Map<string, DevicePoint>();

  for (const p of prev || []) map.set(pointKey(p), p);

  for (const p of next || []) {
    const key = pointKey(p);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, p);
      continue;
    }

    // Merge properties, preferring defined values from `p`,
    // but preserving numeric accuracy/cov from existing if missing in `p`.
    const prevComp = existing ?? {} as DevicePoint;
    const newComp = p ?? {} as DevicePoint;

    const mergedComp: DevicePoint = { ...prevComp, ...newComp } as DevicePoint;

    if (typeof newComp.accuracy !== "number" && typeof prevComp.accuracy === "number") {
      mergedComp.accuracy = prevComp.accuracy;
    }

    if (!Array.isArray(newComp.cov) && Array.isArray(prevComp.cov)) {
      mergedComp.cov = prevComp.cov as DevicePoint["cov"];
    }

    map.set(key, mergedComp);
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function pruneSnapshots(points: DevicePoint[], sinceMs: number) {
  if (!Array.isArray(points)) return [];
  return points.filter((p) => typeof p?.timestamp === "number" && p.timestamp >= sinceMs).sort((a, b) => a.timestamp - b.timestamp);
}
