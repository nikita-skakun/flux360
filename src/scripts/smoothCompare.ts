import { haversineDistance, pointLineDistance } from "@/util/geo";
import { parseArgs } from "util";
import { parseGpx } from "@/util/gpx";
import { readFile, writeFile } from "fs/promises";
import { smoothPath } from "@/util/pathSmoothing";
import path from "path";
import type { NormalizedPosition, Vec2 } from "@/types";

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
  const { values } = parseArgs({
    options: {
      raw: { type: "string" },
      clean: { type: "string" },
      iterations: { type: "string", default: "3" },
      simplify: { type: "string", default: "0" },
      out: { type: "string" },
    }
  });

  if (!values.raw || !values.clean) {
    throw new Error("Missing required arguments: --raw and --clean are required.");
  }

  const rawJson = JSON.parse(await readFile(path.resolve(values.raw), "utf-8")) as {
    data: Record<number, Array<NormalizedPosition>>;
  };

  const rawPoints = Object.values(rawJson.data).flat();
  if (rawPoints.length === 0) {
    throw new Error(`No device data found in ${values.raw}`);
  }

  const cleanRaw = await readFile(path.resolve(values.clean), "utf-8");
  if (!values.clean.toLowerCase().endsWith(".gpx")) {
    throw new Error("Only GPX clean tracks are supported; please provide a .gpx file.");
  }

  const cleanPoints = parseGpx(cleanRaw);
  if (cleanPoints.length === 0) throw new Error("No points found in clean track.");

  const rawPathPoints: Array<{ point: Vec2; accuracy: number; timestamp: number }> = rawPoints
    .map((p: NormalizedPosition) => ({ point: p.geo, accuracy: p.accuracy ?? 100, timestamp: p.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp);

  let smoothed = smoothPath(rawPathPoints, Number(values.iterations)).map((geo, i) => ({
    timestamp: rawPathPoints[i]?.timestamp ?? 0,
    geo,
  }));

  if (Number(values.simplify) > 0) {
    smoothed = simplifyPath(smoothed.map(p => p.geo), Number(values.simplify)).map((geo, i) => ({
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

  if (values.out) {
    const geojson = {
      type: "FeatureCollection",
      features: [
        { ...buildGeoJsonLineString(smoothed.map(p => p.geo)), properties: { label: "smoothed" } },
      ],
    };
    await writeFile(values.out, JSON.stringify(geojson, null, 2), "utf-8");
    console.log(`Wrote GeoJSON to ${values.out}`);
  }
}

main().catch(err => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
