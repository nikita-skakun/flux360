import type { ComponentUI } from "@/ui/types";

type Snapshot = { timestamp: number; data: { components: ComponentUI[] } };

function snapshotKey(s: Snapshot) {
  const c = s?.data?.components?.[0] as ComponentUI | undefined;
  return `${c?.device ?? "unknown"}:${s.timestamp}:${c?.lat}:${c?.lon}`;
}

export function mergeSnapshots(prev: Snapshot[], next: Snapshot[]) {
  const map = new Map<string, Snapshot>();

  for (const s of prev || []) map.set(snapshotKey(s), s);

  for (const s of next || []) {
    const key = snapshotKey(s);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, s);
      continue;
    }

    // Merge first component properties, preferring defined values from `s`,
    // but preserving numeric accuracy/cov from existing if missing in `s`.
    const prevComp = existing.data?.components?.[0] ?? {} as Partial<ComponentUI>;
    const newComp = s.data?.components?.[0] ?? {} as Partial<ComponentUI>;

    const mergedComp: Partial<ComponentUI> = { ...prevComp, ...newComp };

    if (typeof newComp.accuracy !== "number" && typeof prevComp.accuracy === "number") {
      mergedComp.accuracy = prevComp.accuracy;
    }

    if (!Array.isArray(newComp.cov) && Array.isArray(prevComp.cov)) {
      mergedComp.cov = prevComp.cov;
    }

    // preserve raw flag if either says it's raw
    mergedComp.raw = !!prevComp.raw || !!newComp.raw;

    const mergedSnap: Snapshot = { ...existing, ...s, data: { components: [mergedComp as ComponentUI] } };
    map.set(key, mergedSnap);
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Normalize timestamps on persisted snapshots that may be in seconds.
 * Returns a new sorted array with timestamps in milliseconds.
 */
export function normalizeSnapshots(snaps: Snapshot[]) {
  if (!Array.isArray(snaps)) return [];
  return snaps
    .map((s) => {
      const rawTs = (s as unknown as { timestamp?: unknown })?.timestamp;
      let ts: number;
      if (typeof rawTs === "number") {
        ts = rawTs < 1e12 ? Math.round(rawTs * 1000) : rawTs;
      } else if (typeof rawTs === "string") {
        const n = Number(rawTs);
        ts = !Number.isNaN(n) ? (n < 1e12 ? Math.round(n * 1000) : n) : Date.now();
      } else {
        ts = Date.now();
      }
      return { ...s, timestamp: ts } as Snapshot;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function pruneSnapshots(snaps: Snapshot[], sinceMs: number) {
  if (!Array.isArray(snaps)) return [];
  return snaps
    .filter((s) => typeof s?.timestamp === "number" && s.timestamp >= sinceMs)
    .sort((a, b) => a.timestamp - b.timestamp);
}
