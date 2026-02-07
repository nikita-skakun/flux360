export type DrawItem = { idx: number; device: number; x: number; y: number; r: number; timestamp: number; iconText: string; color: [number, number, number]; };
export type Cluster = { items: DrawItem[]; x: number; y: number; size: number; radius: number };

export const CLUSTER_DISTANCE_PX = 36;

export function clusterRadius(size: number) {
  return Math.max(8, Math.ceil(6 + Math.sqrt(size) * 6));
}

export function computeClusters(items: DrawItem[], threshold = CLUSTER_DISTANCE_PX): Cluster[] {
  const n = items.length;
  if (n === 0) return [];
  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : parent[i] = find(parent[i]!);
  const union = (i: number, j: number) => { const pi = find(i), pj = find(j); if (pi !== pj) parent[pi] = pj; };
  const cellSize = threshold;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (!item) continue;
    const key = `${Math.floor(item.x / cellSize)},${Math.floor(item.y / cellSize)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }
  for (let i = 0; i < n; i++) {
    const item = items[i]!;
    const cellX = Math.floor(item.x / cellSize);
    const cellY = Math.floor(item.y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${cellX + dx},${cellY + dy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const other = items[j]!;
          if (Math.hypot(item.x - other.x, item.y - other.y) <= threshold) union(i, j);
        }
      }
    }
  }
  const groups = Array.from({ length: n }, () => [] as DrawItem[]);
  for (let i = 0; i < n; i++) groups[find(i)]!.push(items[i]!);
  const clusters: Cluster[] = [];
  for (let i = 0; i < n; i++) {
    const clusterItems = groups[i]!;
    if (clusterItems.length === 0) continue;
    const avgX = clusterItems.reduce((s, it) => s + it.x, 0) / clusterItems.length;
    const avgY = clusterItems.reduce((s, it) => s + it.y, 0) / clusterItems.length;
    clusters.push({ items: clusterItems, x: avgX, y: avgY, size: clusterItems.length, radius: clusterRadius(clusterItems.length) });
  }
  return clusters;
}