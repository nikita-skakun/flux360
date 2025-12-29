import type { DevicePoint } from "@/ui/types";

export function pruneSnapshots(points: DevicePoint[], sinceMs: number) {
  if (!Array.isArray(points)) return [];
  return points.filter((p) => typeof p?.timestamp === "number" && p.timestamp >= sinceMs).sort((a, b) => a.timestamp - b.timestamp);
}
