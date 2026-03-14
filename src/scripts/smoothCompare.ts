import { distance, haversineDistance } from "@/util/geo";
import { readFile, writeFile } from "fs/promises";
import { smoothPath } from "@/util/pathSmoothing";
import { toWebMercator } from "@/util/webMercator";
import path from "path";
import type { NormalizedPosition, Vec2 } from "@/types";

function usage(): string {
  return `Usage: bun src/scripts/smoothCompare.ts --raw <raw.json> --clean <track.gpx> [options]

Options:
  --raw <path>         Raw data export (from collectRawFromTrack.ts).
  --clean <path>       Clean reference track (GPX).
  --iterations <n>     Smoothing iterations (default: 3).
  --simplify <meters>  Simplify smoothed path using Ramer-Douglas-Peucker (default: 0 = disabled).
  --out <path>         Output GeoJSON of smoothed path.
  --help               Show this help.
`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "help") {
      out["help"] = "true";
      continue;
    }
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "";
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function parseGpxTrack(xml: string): Array<{ timestamp: number; geo: Vec2 }> {
  const entries: Array<{ timestamp: number; geo: Vec2 }> = [];
  const trkptRegex = /<trkpt\s+[^>]*lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let match: RegExpExecArray | null;
  while ((match = trkptRegex.exec(xml))) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    const body = match[3] ?? "";
    const timeMatch = /<time>([^<]+)<\/time>/i.exec(body);
    const tsStr = timeMatch?.[1];
    if (!tsStr) continue;
    const ts = Date.parse(tsStr);
    if (Number.isNaN(ts)) continue;
    entries.push({ timestamp: ts, geo: [lon, lat] });
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function findClosestByDistance<T extends { geo: Vec2 }>(items: T[], geo: Vec2): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const item of items) {
    const d = haversineDistance(item.geo, geo);
    if (d < bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best;
}

function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  // Use Web Mercator for planar distance in meters.
  const pM = toWebMercator(p);
  const aM = toWebMercator(a);
  const bM = toWebMercator(b);

  const dx = bM[0] - aM[0];
  const dy = bM[1] - aM[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return distance(pM, aM);

  const t = ((pM[0] - aM[0]) * dx + (pM[1] - aM[1]) * dy) / l2;
  const tClamped = Math.max(0, Math.min(1, t));
  const proj: Vec2 = [aM[0] + tClamped * dx, aM[1] + tClamped * dy];
  return distance(pM, proj);
}

function simplifyPath(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return points;

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  function simplifySegment(start: number, end: number): void {
    let maxDist = 0;
    let index = -1;
    const startPt = points[start];
    const endPt = points[end];
    if (!startPt || !endPt) return;

    for (let i = start + 1; i < end; i++) {
      const pt = points[i];
      if (!pt) continue;
      const d = pointLineDistance(pt, startPt, endPt);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index !== -1) {
      keep[index] = true;
      simplifySegment(start, index);
      simplifySegment(index, end);
    }
  }

  simplifySegment(0, points.length - 1);
  return points.filter((_, idx) => keep[idx]);
}

function stats(values: number[]): { count: number; mean: number; median: number; max: number } {
  if (values.length === 0) return { count: 0, mean: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mid = Math.floor(sorted.length / 2);
  let median: number;
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1];
    const b = sorted[mid];
    median = (a ?? 0) + (b ?? 0);
    median /= 2;
  } else {
    median = sorted[mid] ?? 0;
  }

  const max = sorted[sorted.length - 1] ?? 0;
  return { count: sorted.length, mean: sum / sorted.length, median, max };
}

function buildGeoJsonLineString(points: Vec2[]): { type: "Feature"; geometry: { type: "LineString"; coordinates: Vec2[] }; properties: Record<string, unknown> } {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: points,
    },
    properties: {},
  };
}

async function main() {
  const args = parseArgs();
  if (args["help"]) {
    console.log(usage());
    return;
  }

  const rawPath = args["raw"];
  const cleanPath = args["clean"];
  if (!rawPath || !cleanPath) {
    throw new Error("Missing required arguments: --raw and --clean are required.");
  }

  const rawJson = JSON.parse(await readFile(path.resolve(rawPath), "utf-8")) as {
    data: Record<number, Array<NormalizedPosition>>;
  };

  const rawPoints = Object.values(rawJson.data).flat();
  if (rawPoints.length === 0) {
    throw new Error(`No device data found in ${rawPath}`);
  }

  const iterations = args["iterations"] ? Number(args["iterations"]) : 3;
  const simplifyMeters = args["simplify"] ? Number(args["simplify"]) : 0;

  const cleanRaw = await readFile(path.resolve(cleanPath), "utf-8");
  if (!cleanPath.toLowerCase().endsWith(".gpx")) {
    throw new Error("Only GPX clean tracks are supported; please provide a .gpx file.");
  }
  const cleanPoints = parseGpxTrack(cleanRaw);

  if (cleanPoints.length === 0) throw new Error("No points found in clean track.");

  const rawPathPoints: Array<{ point: Vec2; accuracy: number; timestamp: number }> = rawPoints
    .map((p: NormalizedPosition) => ({ point: p.geo, accuracy: p.accuracy ?? 100, timestamp: p.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp);

  let smoothed = smoothPath(rawPathPoints, iterations).map((geo, i) => ({
    timestamp: rawPathPoints[i]?.timestamp ?? 0,
    geo,
  }));

  if (simplifyMeters > 0) {
    smoothed = simplifyPath(smoothed.map(p => p.geo), simplifyMeters).map((geo, i) => ({
      timestamp: smoothed[i]?.timestamp ?? 0,
      geo,
    }));
  }

  // Compare each raw point to its nearest clean point (spatially) without shifting
  const distances = smoothed
    .map(p => {
      const closest = findClosestByDistance(cleanPoints, p.geo);
      return closest ? haversineDistance(p.geo, closest.geo) : NaN;
    })
    .filter(d => !Number.isNaN(d));

  const statsResult = stats(distances);
  console.log(`Mean=${statsResult.mean.toFixed(1)}m, median=${statsResult.median.toFixed(1)}m, max=${statsResult.max.toFixed(1)}m, count=${statsResult.count}`);
  console.log(`Raw points: ${rawPoints.length}, clean points: ${cleanPoints.length}`);

  const outPath = args["out"];
  if (outPath) {
    const geojson = {
      type: "FeatureCollection",
      features: [
        { ...buildGeoJsonLineString(smoothed.map(p => p.geo)), properties: { label: "smoothed" } },
      ],
    };
    await writeFile(outPath, JSON.stringify(geojson, null, 2), "utf-8");
    console.log(`Wrote GeoJSON to ${outPath}`);
  }
}

main().catch(err => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
