import type { ComponentUI } from "@/ui/types";

type Snapshot = { timestamp: number; data: { components: ComponentUI[] } };

function snapshotKey(s: Snapshot) {
  const c = s?.data?.components?.[0] as any;
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
    const prevComp = existing.data?.components?.[0] ?? {} as any;
    const newComp = s.data?.components?.[0] ?? {} as any;

    const mergedComp: any = { ...prevComp, ...newComp };

    if (typeof newComp.accuracy !== "number" && typeof prevComp.accuracy === "number") {
      mergedComp.accuracy = prevComp.accuracy;
    }

    if (!Array.isArray(newComp.cov) && Array.isArray(prevComp.cov)) {
      mergedComp.cov = prevComp.cov;
    }

    // preserve raw flag if either says it's raw
    mergedComp.raw = !!prevComp.raw || !!newComp.raw;

    const mergedSnap: Snapshot = { ...existing, ...s, data: { components: [mergedComp] } };
    map.set(key, mergedSnap);
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}
