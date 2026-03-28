import { computeBestFitMotionPath } from "@/util/motionBestFit";
import { dot, EPSILON, length, nearestPointOnPolyline, sub } from "@/util/vec2";
import { encode } from "@toon-format/toon";
import { MotionEventSchema } from "@/types";
import { parseArgs } from "util";
import { readFile } from "fs/promises";
import { z } from "zod";
import type { Vec2 } from "@/types";

const MotionInputSchema = z.union([
  MotionEventSchema,
  z.object({ ev: MotionEventSchema }),
]);

function turnAnglesDeg(points: Vec2[]): number[] {
  if (points.length < 3) return [];

  const result: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = sub(points[i]!, points[i - 1]!);
    const b = sub(points[i + 1]!, points[i]!);
    const la = length(a);
    const lb = length(b);
    if (la < 1e-9 || lb < 1e-9) {
      result.push(0);
      continue;
    }
    const cos = Math.min(1, Math.max(-1, dot(a, b) / (la * lb)));
    result.push((Math.acos(cos) * 180) / Math.PI);
  }
  return result;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((acc, v) => acc + v, 0);
  return total / values.length;
}

function countSharpTurns(turns: number[], thresholdDeg: number): number {
  return turns.filter(t => t >= thresholdDeg).length;
}

function maxTurn(turns: number[]): number {
  if (turns.length === 0) return 0;
  return Math.max(...turns);
}

function countBacktracks(points: Vec2[], axisStart: Vec2, axisEnd: Vec2): number {
  if (points.length < 2) return 0;

  const axis = sub(axisEnd, axisStart);
  const axisLen = length(axis);
  if (axisLen < 1e-9) return 0;

  const tangent: Vec2 = [axis[0] / axisLen, axis[1] / axisLen];
  let prevT = dot(sub(points[0]!, axisStart), tangent);
  let count = 0;

  for (let i = 1; i < points.length; i++) {
    const t = dot(sub(points[i]!, axisStart), tangent);
    if (t < prevT - EPSILON) count++;
    prevT = t;
  }

  return count;
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      sharp: { type: "string", default: "80" },
    }
  });

  if (!values.input) throw new Error("Missing --input path to a motion event JSON file.");

  const parsed = MotionInputSchema.parse(JSON.parse(await readFile(values.input, "utf-8")));
  const ev = "type" in parsed ? parsed : parsed.ev;
  if (ev.type !== "motion") throw new Error("Input JSON does not contain a motion event.");

  const rawPath = ev.path.map(p => p.geo);
  const fitPath = computeBestFitMotionPath(ev.path);

  const rawTurns = turnAnglesDeg(rawPath);
  const fitTurns = turnAnglesDeg(fitPath);

  const fitProjections = ev.path.map((p) => {
    const best = nearestPointOnPolyline(p.geo, fitPath);
    const dist = length(sub(best, p.geo));
    return { best, dist };
  });

  const fitOffsets = fitProjections.map(item => item.dist);
  const fitOffsetRatios = ev.path.map((p, idx) => {
    const offset = fitOffsets[idx] ?? 0;
    const accuracy = Math.max(EPSILON, p.accuracy);
    return offset / accuracy;
  });

  const sharpThreshold = Number(values.sharp);
  const radii = ev.path.map(p => Math.max(0, p.accuracy));
  const fitViolations: { idx: number; overBy: number }[] = [];
  for (let i = 0; i < rawPath.length; i++) {
    const c = rawPath[i]!;
    const nearest = nearestPointOnPolyline(c, fitPath);
    const d = length(sub(nearest, c));
    const r = radii[i] ?? 0;
    if (d > r + EPSILON) fitViolations.push({ idx: i, overBy: d - r });
  }

  const report = {
    summary: {
      sharpThresholdDeg: sharpThreshold,
      raw: {
        sharpTurns: countSharpTurns(rawTurns, sharpThreshold),
        maxTurnDeg: Number(maxTurn(rawTurns).toFixed(2)),
        p95TurnDeg: Number(percentile(rawTurns, 0.95).toFixed(2)),
        backtracks: countBacktracks(rawPath, ev.startAnchor, ev.endAnchor),
      },
      bestFit: {
        sharpTurns: countSharpTurns(fitTurns, sharpThreshold),
        maxTurnDeg: Number(maxTurn(fitTurns).toFixed(2)),
        p95TurnDeg: Number(percentile(fitTurns, 0.95).toFixed(2)),
        backtracks: countBacktracks(fitPath, ev.startAnchor, ev.endAnchor),
        circleViolations: fitViolations.length,
        maxCircleViolationMeters: Number(Math.max(0, ...fitViolations.map(v => v.overBy)).toFixed(4)),
        meanFitOffsetMeters: Number(mean(fitOffsets).toFixed(3)),
        p95FitOffsetMeters: Number(percentile(fitOffsets, 0.95).toFixed(3)),
        maxFitOffsetMeters: Number(Math.max(0, ...fitOffsets).toFixed(3)),
        meanFitOffsetRatioToAccuracy: Number(mean(fitOffsetRatios).toFixed(3)),
      },
    },
    perPoint: ev.path.map((p, idx) => {
      const toCenter = fitProjections[idx]!.dist;
      return {
        idx,
        timestamp: p.timestamp,
        accuracy: p.accuracy,
        fitOffsetMeters: Number(toCenter.toFixed(3)),
        fitInsideAccuracy: toCenter <= p.accuracy + EPSILON,
        x: Number(p.geo[0].toFixed(3)),
        y: Number(p.geo[1].toFixed(3)),
      };
    }),
    bestFitVertices: fitPath.map((p) => ({
      x: Number(p[0].toFixed(3)),
      y: Number(p[1].toFixed(3)),
    })),
    rawTurnAnglesDeg: rawTurns.map(v => Number(v.toFixed(2))),
    bestFitTurnAnglesDeg: fitTurns.map(v => Number(v.toFixed(2))),
  };

  process.stdout.write(encode(report));
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});