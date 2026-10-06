import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabelKindSchema, LabelSchema } from "@/labels/types";
import { addLabel, labeledCoverageMs, listLabeledEntityIds, readLabels, removeLabel, updateLabel } from "@/labels/store";
import type { Label } from "@/labels/types";

const dir = mkdtempSync(join(tmpdir(), "flux360-labels-"));
process.env["FLUX360_LABEL_DIR"] = join(dir, "labels");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: `l-${Math.random().toString(36).slice(2)}`,
    deviceId: 1,
    kind: "stationary",
    start: 1_700_000_000_000,
    end: 1_700_000_000_000 + HOUR,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  for (const id of listLabeledEntityIds()) {
    for (const existing of readLabels(id)) removeLabel(id, existing.id);
  }
});

describe("label store", () => {
  test("a label round-trips through the file", () => {
    const written = addLabel(label({ note: "at home" }));
    const read = readLabels(1);
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(written);
  });

  test("entities are stored separately, including groups by negative id", () => {
    addLabel(label({ deviceId: 1 }));
    addLabel(label({ deviceId: -4, kind: "car" }));

    expect(listLabeledEntityIds().sort((a, b) => a - b)).toEqual([-4, 1]);
    expect(readLabels(1)).toHaveLength(1);
    expect(readLabels(-4)).toHaveLength(1);
    expect(readLabels(-4)[0]?.kind).toBe("car");
  });

  test("updating replaces in place and removing drops it", () => {
    const first = addLabel(label());
    addLabel(label());

    expect(updateLabel({ ...first, kind: "bike" })).toBe(true);
    expect(readLabels(1).filter(l => l.id === first.id)[0]?.kind).toBe("bike");

    expect(removeLabel(1, first.id)).toBe(true);
    expect(readLabels(1)).toHaveLength(1);
    expect(removeLabel(1, first.id)).toBe(false);
  });

  test("an unknown entity reads as empty rather than failing", () => {
    expect(readLabels(999)).toEqual([]);
    expect(labeledCoverageMs(999)).toBe(0);
  });

  test("a malformed line is discarded without losing the rest", () => {
    addLabel(label({ kind: "walk" }));
    const path = join(dir, "labels", "1.jsonl");
    const good = readFileSync(path, "utf-8");
    Bun.write(path, `${good}not json at all\n{"id":"x"}\n`);
    expect(readLabels(1)).toHaveLength(1);
  });

  test("coverage sums the labelled spans", () => {
    addLabel(label({ start: 0, end: HOUR }));
    addLabel(label({ start: 2 * HOUR, end: 2 * HOUR + 30 * 60_000 }));
    expect(labeledCoverageMs(1)).toBe(HOUR + 30 * 60_000);
  });

  test("every kind survives validation", () => {
    const kinds = LabelKindSchema.options;
    for (const kind of kinds) {
      expect(LabelSchema.safeParse(label({ kind })).success).toBe(true);
    }
    expect(LabelSchema.safeParse({ ...label(), kind: "teleport" }).success).toBe(false);
  });
});
