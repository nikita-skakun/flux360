import { calculateOutlierScore } from "@/util/motionOutliers";
import { decode, encode } from "@toon-format/toon";
import { MotionEventSchema } from "@/types";
import { parseArgs } from "util";
import { parseDecodedMotionEvent } from "@/util/motionEventParsing";
import { readFile } from "fs/promises";
import { z } from "zod";

const MotionInputSchema = z.union([
  MotionEventSchema,
  z.object({ ev: MotionEventSchema }),
]);

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
    }
  });

  if (!values.input) throw new Error("Missing --input path to a motion event TOON file.");

  const parsed = parseDecodedMotionEvent(decode(await readFile(values.input, "utf-8")), MotionInputSchema);
  if (!parsed) throw new Error("Failed to parse TOON file.");

  const ev = "type" in parsed ? parsed : parsed.ev;

  const path = [...ev.path, ...ev.outliers].sort((a, b) => a.timestamp - b.timestamp);
  if (path.length < 3) throw new Error("Not enough points to calculate neighbor metrics");

  const metrics = [];

  for (let i = 1; i < path.length - 1; i++) {
    const A = path[i - 1];
    const B = path[i];
    const C = path[i + 1];

    if (!A || !B || !C) continue;

    const { duration, distance, speed, directSpeed, ratio, score } = calculateOutlierScore(A, B, C, (p) => p.geo);

    metrics.push({
      idx: i,
      duration: Number(duration.toFixed(3)),
      distance: Number(distance.toFixed(3)),
      speed: Number(speed.toFixed(3)),
      directSpeed: Number(directSpeed.toFixed(3)),
      ratio: Number(ratio.toFixed(2)),
      score: Number(score.toFixed(3)),
    });
  }

  process.stdout.write(encode(metrics));
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
