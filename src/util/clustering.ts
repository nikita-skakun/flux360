import type { Timestamp } from "@/types";

export type DrawItem = { idx: number; device: number; x: number; y: number; r: number; timestamp: Timestamp; iconText: string; color: [number, number, number]; };
export type Cluster = { items: DrawItem[]; x: number; y: number; size: number; radius: number };

export const CLUSTER_DISTANCE_PX = 36;

export function clusterRadius(size: number) {
  return Math.max(8, Math.ceil(6 + Math.sqrt(size) * 6));
}

// Encode (cellX, cellY) as a single integer key — avoids string allocation in hot loops.
const cellKey = (cx: number, cy: number) => ((cx & 0xffff) << 16) | (cy & 0xffff);
const getOrSet = <K, V>(m: Map<K, V>, k: K, v: V): V => {
  const e = m.get(k);
  if (e !== undefined) return e;
  m.set(k, v); return v;
};

export function computeClusters(items: DrawItem[], threshold = CLUSTER_DISTANCE_PX): Cluster[] {
  const n = items.length;
  if (n === 0) return [];

  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    for (let p = parent[i]; p !== undefined && p !== i; p = parent[i]) {
      const gp = parent[p]; if (gp !== undefined) parent[i] = gp; // path-halving
      i = p;
    }
    return i;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item !== undefined) getOrSet(grid, cellKey(Math.floor(item.x / threshold), Math.floor(item.y / threshold)), []).push(i);
  }

  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const cx = Math.floor(item.x / threshold), cy = Math.floor(item.y / threshold);
    const thresholdSq = threshold * threshold;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(cellKey(cx + dx, cy + dy));
        if (cell === undefined) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const other = items[j];
          if (other !== undefined) {
            const dx = item.x - other.x;
            const dy = item.y - other.y;
            if (dx * dx + dy * dy <= thresholdSq) union(i, j);
          }
        }
      }
    }
  }

  const groups = new Map<number, DrawItem[]>();
  for (let i = 0; i < n; i++) { const item = items[i]; if (item !== undefined) getOrSet(groups, find(i), []).push(item); }

  return Array.from(groups.values(), clusterItems => {
    let sumX = 0, sumY = 0;
    for (const it of clusterItems) { sumX += it.x; sumY += it.y; }
    const len = clusterItems.length;
    return { items: clusterItems, x: sumX / len, y: sumY / len, size: len, radius: clusterRadius(len) };
  });
}