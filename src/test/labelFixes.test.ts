import { describe, expect, test } from "bun:test";
import {
  LABEL_CHUNK_MS, MAX_EMPTY_PAGES, fixAtPoint, kindsAtFixes, labelAtFix, labelBoundaryIndices,
  labelFixRange, labelsCovering, mergeFixes, outlierAt, walkBackForFixes,
} from "@/labels/fixes";
import { metricDistance, toWebMercator } from "@/util/webMercator";
import { applyOpToLabels, opEntityId, opLabel } from "@/labels/undo";
import { ClientMessageSchema, ServerMessageSchema } from "@/types";
import type { Label, StripFix } from "@/labels/types";
import type { LabelOp } from "@/labels/undo";

const T0 = 1_700_000_000_000;

const fixes: StripFix[] = Array.from({ length: 10 }, (_, index) => ({
  device: 1,
  geo: [10, 50],
  accuracy: 20,
  timestamp: T0 + index * 1000,
}));

function label(overrides: Partial<Label> = {}): Label {
  return { id: "l", deviceId: 1, kind: "stationary", start: T0, end: T0 + 4000, createdAt: 0, ...overrides };
}

describe("fix helpers", () => {
  test("the chunk window is days, not hours", () => {
    expect(LABEL_CHUNK_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  test("merging dedupes by device and timestamp and keeps time order", () => {
    const merged = mergeFixes(
      [{ device: 1, geo: [10, 50], accuracy: 20, timestamp: T0 + 2000 }, fixes[0] as StripFix],
      [{ device: 2, geo: [10, 50], accuracy: 20, timestamp: T0 + 1000 }, fixes[0] as StripFix]
    );
    expect(merged.map(fix => `${fix.device}:${fix.timestamp}`)).toEqual([
      `1:${T0}`, `2:${T0 + 1000}`, `1:${T0 + 2000}`,
    ]);
  });

  test("a label maps onto the fix indices it covers", () => {
    const ranges = labelsCovering(fixes, [label()]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.first).toBe(0);
    expect(ranges[0]?.last).toBe(4);
  });

  test("point labels are not spans", () => {
    const outlier = label({ kind: "outlier", start: T0 + 3000, end: T0 + 3000 });
    expect(labelsCovering(fixes, [outlier])).toHaveLength(0);
    expect(outlierAt(fixes, [outlier], 3)).toBe(true);
    expect(outlierAt(fixes, [outlier], 4)).toBe(false);
  });

  test("a label covering no fix is skipped rather than pinned to a neighbour", () => {
    const gap = label({ start: T0 + 500_000, end: T0 + 600_000 });
    expect(labelsCovering(fixes, [gap])).toHaveLength(0);
  });

  test("a span's fix range matches what labelsCovering reports", () => {
    expect(labelFixRange(fixes, label())).toEqual({ first: 0, last: 4 });
  });

  test("a point label still has a fix range, for selecting the span it touches", () => {
    expect(labelFixRange(fixes, label({ kind: "outlier", start: T0 + 3000, end: T0 + 3000 }))).toEqual({ first: 3, last: 3 });
    expect(labelFixRange(fixes, label({ kind: "waypoint", start: T0 + 3000, end: T0 + 6000 }))).toEqual({ first: 3, last: 6 });
  });

  test("a span whose fixes are not loaded has no range", () => {
    expect(labelFixRange(fixes, label({ start: T0 - 9000, end: T0 - 5000 }))).toBeNull();
  });

  test("a partially loaded span clamps to the fixes that are present", () => {
    expect(labelFixRange(fixes, label({ start: T0 - 9000, end: T0 + 2000 }))).toEqual({ first: 0, last: 2 });
    expect(labelFixRange(fixes, label({ start: T0 + 7000, end: T0 + 9000 }))).toEqual({ first: 7, last: 9 });
  });

  test("two labels sharing a boundary fix both claim it, and the later one paints it", () => {
    const first = label({ id: "a", start: T0, end: T0 + 4000 });
    const second = label({ id: "b", kind: "car", start: T0 + 4000, end: T0 + 9000 });
    const ranges = labelsCovering(fixes, [first, second]);
    expect(ranges.map(range => [range.first, range.last])).toEqual([[0, 4], [4, 9]]);
    expect(labelAtFix(ranges, fixes, 4)?.id).toBe("b");
    expect(labelAtFix(ranges, fixes, 2)?.id).toBe("a");
    expect(labelAtFix(ranges, fixes, 9)?.id).toBe("b");
  });

  test("boundary seams land on every label end", () => {
    const first = label({ id: "a", start: T0, end: T0 + 4000 });
    const second = label({ id: "b", kind: "car", start: T0 + 4000, end: T0 + 9000 });
    expect(labelBoundaryIndices(fixes, [first, second])).toEqual([0, 4, 9]);
  });

  test("an unlabelled fix has no colour", () => {
    expect(labelAtFix(labelsCovering(fixes, []), fixes, 0)).toBeNull();
  });
});

describe("label ops", () => {
  const base = label();

  test("applying an add keeps the list sorted by insertion and replaces duplicates", () => {
    const added = applyOpToLabels([], { kind: "add", label: base });
    expect(added).toHaveLength(1);
    const replaced = applyOpToLabels(added, { kind: "add", label: { ...base, kind: "walk" } });
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.kind).toBe("walk");
  });

  test("applying an update replaces in place and a remove drops it", () => {
    const updated = applyOpToLabels([base], { kind: "update", before: base, after: { ...base, kind: "bike" } });
    expect(updated[0]?.kind).toBe("bike");
    expect(applyOpToLabels(updated, { kind: "remove", label: base })).toEqual([]);
  });

  test("an op names its entity and the label it sends", () => {
    const ops: LabelOp[] = [
      { kind: "add", label: base },
      { kind: "remove", label: { ...base, deviceId: -4 } },
      { kind: "update", before: base, after: { ...base, deviceId: -4, kind: "bus" } },
    ];
    expect(ops.map(opEntityId)).toEqual([1, -4, -4]);
    expect(ops.map(op => opLabel(op)?.kind ?? null)).toEqual(["stationary", null, "bus"]);
  });
});

describe("label protocol", () => {
  test("the client can ask for labels, history and label writes", () => {
    expect(ClientMessageSchema.safeParse({ type: "list_labels", payload: { entityId: 1 }, requestId: "r" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "get_history", payload: { entityId: 1, from: 0, to: 1 }, requestId: "r" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "remove_label", payload: { entityId: 1, id: "x" }, requestId: "r" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "set_label", payload: { label: label() }, requestId: "r" }).success).toBe(true);
  });

  test("a malformed label is rejected on the wire", () => {
    expect(ClientMessageSchema.safeParse({
      type: "set_label",
      payload: { label: { ...label(), kind: "teleport" } },
      requestId: "r",
    }).success).toBe(false);
  });

  test("the server can return labels and raw fixes", () => {
    expect(ServerMessageSchema.safeParse({
      type: "labels_list", payload: { entityId: 1, labels: [label()] }, requestId: "r",
    }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({
      type: "history_chunk", payload: { entityId: -4, fixes: [fixes[0]] }, requestId: "r",
    }).success).toBe(true);
  });
});

describe("walking back over gaps", () => {
  test("a stretch of empty pages does not end the walk", async () => {
    const asked: number[] = [];
    const from = await walkBackForFixes(T0, async (pageFrom) => {
      asked.push(pageFrom);
      return pageFrom <= T0 - 6 * LABEL_CHUNK_MS ? 5 : 0;
    });

    // Six pages back, of which the first five are empty, so five gaps are crossed.
    expect(asked).toHaveLength(6);
    expect(from).toBe(T0 - 6 * LABEL_CHUNK_MS);
  });

  test("it stops at the first page that has fixes", async () => {
    let pages = 0;
    await walkBackForFixes(T0, async () => {
      pages += 1;
      return 1;
    });
    expect(pages).toBe(1);
  });

  test("each page is asked for once, immediately before the last one", async () => {
    const asked: [number, number][] = [];
    await walkBackForFixes(T0, async (from, to) => {
      asked.push([from, to]);
      return 0;
    });

    expect(asked[0]).toEqual([T0 - LABEL_CHUNK_MS, T0]);
    expect(asked[1]).toEqual([T0 - 2 * LABEL_CHUNK_MS, T0 - LABEL_CHUNK_MS]);
    expect(asked.every(([from, to]) => to - from === LABEL_CHUNK_MS)).toBe(true);
  });

  test("a device with no history at all is not walked to the beginning of time", async () => {
    let pages = 0;
    const from = await walkBackForFixes(T0, async () => {
      pages += 1;
      return 0;
    });

    expect(pages).toBe(MAX_EMPTY_PAGES);
    expect(from).toBe(T0 - MAX_EMPTY_PAGES * LABEL_CHUNK_MS);
  });
});

const LAT = 50;
const METRE = 1 / 111_320;

function fixNear(offsetMeters: number, accuracy: number, device = 1, timestamp = T0): StripFix {
  return {
    device,
    geo: [10 + offsetMeters * METRE / Math.cos(LAT * Math.PI / 180), LAT],
    accuracy,
    timestamp,
  };
}

describe("the kind each fix carries", () => {
  test("an unclaimed fix has no kind", () => {
    expect(kindsAtFixes(fixes, [])).toEqual(Array(10).fill(null));
  });

  test("a span colours the fixes it covers", () => {
    const kinds = kindsAtFixes(fixes, [label({ kind: "car", start: T0, end: T0 + 4000 })]);
    expect(kinds).toEqual(["car", "car", "car", "car", "car", null, null, null, null, null]);
  });

  test("an outlier wins over the span it sits inside", () => {
    const kinds = kindsAtFixes(fixes, [
      label({ kind: "car", start: T0, end: T0 + 4000 }),
      label({ id: "o", kind: "outlier", start: T0 + 2000, end: T0 + 2000 }),
    ]);
    expect(kinds[2]).toBe("outlier");
    expect(kinds[1]).toBe("car");
  });

  test("a boundary fix takes the later starting label, matching the strip", () => {
    const kinds = kindsAtFixes(fixes, [
      label({ id: "a", start: T0, end: T0 + 4000 }),
      label({ id: "b", kind: "car", start: T0 + 4000, end: T0 + 9000 }),
    ]);
    expect(kinds[4]).toBe("car");
    expect(kinds[3]).toBe("stationary");
  });
});

describe("clicking a circle on the map", () => {
  const west = fixNear(-200, 30);
  const east = fixNear(200, 30);

  test("a click inside a circle picks it", () => {
    const picked = fixAtPoint([west, east], toWebMercator(fixNear(-190, 5).geo), 0);
    expect(picked).toBe(west);
  });

  test("a click outside every circle picks nothing", () => {
    expect(fixAtPoint([west, east], toWebMercator(fixNear(0, 5).geo), 0)).toBeNull();
  });

  test("overlapping circles resolve to the nearer centre", () => {
    const near = fixNear(-100, 40);
    const far = fixNear(100, 40);
    expect(fixAtPoint([far, near], toWebMercator(fixNear(-110, 5).geo), 0)).toBe(near);
  });

  test("a precise fix stays clickable when its drawn circle is floored in pixels", () => {
    const precise = fixNear(0, 2);
    const clicked = toWebMercator(fixNear(4, 2).geo);
    expect(metricDistance(toWebMercator(precise.geo), clicked)).toBeGreaterThan(2);
    expect(fixAtPoint([precise], clicked, 0)).toBeNull();
    expect(fixAtPoint([precise], clicked, 10)).toBe(precise);
  });
});
