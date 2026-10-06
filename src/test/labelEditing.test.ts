import { describe, expect, test } from "bun:test";
import {
  EMPTY_SELECTION, OUTLIER_BULK_LIMIT, extendSelection, isIndexSelected, outlierTimestamps,
  selectPoint, selectedFixes, selectionCount, selectionRange, selectionWindow, togglePoint,
} from "@/labels/selection";
import { checkPlacement, unavailableKinds } from "@/labels/validation";
import { applyOp, invertOp, popUndo, pushOp } from "@/labels/undo";
import type { LabelIo, LabelOp } from "@/labels/undo";
import type { Label } from "@/labels/types";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function label(overrides: Partial<Label> = {}): Label {
  return { id: "l", deviceId: 1, kind: "stationary", start: T0, end: T0 + HOUR, createdAt: 0, ...overrides };
}

const fixes = Array.from({ length: 500 }, (_, index) => ({ timestamp: T0 + index * 1000 }));

describe("selection", () => {
  test("an empty selection has no range", () => {
    expect(selectionRange(EMPTY_SELECTION)).toBeNull();
    expect(selectionCount(EMPTY_SELECTION)).toBe(0);
    expect(selectionWindow(EMPTY_SELECTION, fixes)).toBeNull();
  });

  test("clicking then shift-clicking selects everything between", () => {
    const selection = extendSelection(selectPoint(10), 20);
    expect(selectionRange(selection)).toEqual({ from: 10, to: 20 });
    expect(selectionCount(selection)).toBe(11);
    expect(isIndexSelected(selection, 15)).toBe(true);
    expect(isIndexSelected(selection, 21)).toBe(false);
  });

  test("shift-clicking backwards selects the same range", () => {
    const forwards = selectionRange(extendSelection(selectPoint(30), 5));
    expect(forwards).toEqual({ from: 5, to: 30 });
  });

  test("extending without an anchor behaves like a fresh click", () => {
    expect(extendSelection(EMPTY_SELECTION, 7)).toEqual({ anchor: 7, head: 7 });
  });

  test("the window carries the timestamps of the first and last fix", () => {
    const window = selectionWindow(extendSelection(selectPoint(10), 20), fixes);
    expect(window?.start).toBe(fixes[10]?.timestamp);
    expect(window?.end).toBe(fixes[20]?.timestamp);
    expect(window?.count).toBe(11);
  });

  test("a range reaching past the fixes is clamped or refused", () => {
    expect(selectionWindow(extendSelection(selectPoint(10), 900), fixes)?.count).toBe(490);
    expect(selectionWindow(selectPoint(900), fixes)).toBeNull();
  });

  test("clicking the same fix again clears the selection", () => {
    const once = togglePoint(EMPTY_SELECTION, 5);
    expect(once).toEqual({ anchor: 5, head: 5 });
    expect(togglePoint(once, 5)).toEqual(EMPTY_SELECTION);
    expect(selectionRange(togglePoint(once, 5))).toBeNull();
  });

  test("clicking a different fix moves the selection rather than clearing it", () => {
    expect(togglePoint(selectPoint(5), 7)).toEqual({ anchor: 7, head: 7 });
  });

  test("clicking inside a range selects that one fix, it does not clear", () => {
    const range = extendSelection(selectPoint(10), 20);
    expect(togglePoint(range, 15)).toEqual({ anchor: 15, head: 15 });
    expect(togglePoint(range, 10)).toEqual({ anchor: 10, head: 10 });
  });

  test("the selected fixes come back as a slice, ready for the map", () => {
    const slice = selectedFixes(extendSelection(selectPoint(10), 12), fixes);
    expect(slice).toHaveLength(3);
    expect(slice[0]?.timestamp).toBe(fixes[10]?.timestamp);
    expect(slice[2]?.timestamp).toBe(fixes[12]?.timestamp);
  });

  test("a backwards selection still yields fixes in time order", () => {
    const slice = selectedFixes(extendSelection(selectPoint(12), 10), fixes);
    expect(slice.map(fix => fix.timestamp)).toEqual([
      fixes[10]?.timestamp as number,
      fixes[11]?.timestamp as number,
      fixes[12]?.timestamp as number,
    ]);
  });

  test("an empty or out-of-range selection yields nothing", () => {
    expect(selectedFixes(EMPTY_SELECTION, fixes)).toEqual([]);
    expect(selectedFixes(selectPoint(900), fixes)).toEqual([]);
  });

  test("outliers come out one timestamp per selected fix", () => {
    const stamps = outlierTimestamps(extendSelection(selectPoint(0), 2), fixes);
    expect(stamps).toEqual([fixes[0]?.timestamp, fixes[1]?.timestamp, fixes[2]?.timestamp] as number[]);
  });

  test("marking a very large range as outliers is refused rather than flooding", () => {
    expect(outlierTimestamps(extendSelection(selectPoint(0), OUTLIER_BULK_LIMIT - 1), fixes)).toHaveLength(OUTLIER_BULK_LIMIT);
    expect(outlierTimestamps(extendSelection(selectPoint(0), OUTLIER_BULK_LIMIT), fixes)).toBeNull();
  });
});

describe("placement", () => {
  test("an empty entity accepts anything", () => {
    expect(checkPlacement([], label()).ok).toBe(true);
  });

  test("overlapping segments are refused", () => {
    const existing = [label({ id: "a", start: T0, end: T0 + HOUR })];
    const result = checkPlacement(existing, label({ id: "b", start: T0 + 30 * 60_000, end: T0 + 2 * HOUR }));
    expect(result).toEqual({ ok: false, reason: "overlaps an existing stationary label", conflictId: "a" });
  });

  test("touching at a boundary is allowed", () => {
    const existing = [label({ id: "a", start: T0, end: T0 + HOUR })];
    expect(checkPlacement(existing, label({ id: "b", kind: "car", start: T0 + HOUR, end: T0 + 2 * HOUR })).ok).toBe(true);
  });

  test("an outlier may sit inside a span", () => {
    const existing = [label({ id: "a", start: T0, end: T0 + HOUR })];
    const outlier = label({ id: "o", kind: "outlier", start: T0 + 600_000, end: T0 + 600_000 });
    expect(checkPlacement(existing, outlier).ok).toBe(true);
  });

  test("the same outlier at the same fix is not written twice", () => {
    const outlier = label({ id: "o", kind: "outlier", start: T0, end: T0 });
    expect(checkPlacement([outlier], { ...outlier, id: "o2" }).ok).toBe(false);
  });

  test("a group label must record its members", () => {
    expect(checkPlacement([], label({ deviceId: -1 })).ok).toBe(false);
    expect(checkPlacement([], label({ deviceId: -1, memberDeviceIds: [3, 4] })).ok).toBe(true);
  });

  test("a backwards span is refused", () => {
    expect(checkPlacement([], label({ start: T0 + HOUR, end: T0 })).ok).toBe(false);
  });
});

describe("locally decided availability", () => {
  const kinds = ["stationary", "car", "walk"] as const;

  test("every kind is available on an empty entity", () => {
    expect(unavailableKinds([], 1, { start: T0, end: T0 + HOUR }, [], kinds)).toEqual([]);
  });

  test("a span overlapping an existing label reports every kind blocked, with a reason", () => {
    const existing = [label({ id: "a", kind: "stationary", start: T0, end: T0 + HOUR })];
    const blocked = unavailableKinds(existing, 1, { start: T0 + 1000, end: T0 + 2000 }, [], kinds);
    expect(blocked.map(entry => entry.kind)).toEqual([...kinds]);
    expect(blocked[0]?.reason).toBe("overlaps an existing stationary label");
  });

  test("a span merely touching an existing label stays available", () => {
    const existing = [label({ id: "a", kind: "stationary", start: T0, end: T0 + HOUR })];
    expect(unavailableKinds(existing, 1, { start: T0 + HOUR, end: T0 + 2 * HOUR }, [], kinds)).toEqual([]);
  });

  test("outlier labels never block a span, they sit inside one", () => {
    const existing = [label({ id: "o", kind: "outlier", start: T0 + 500, end: T0 + 500 })];
    expect(unavailableKinds(existing, 1, { start: T0, end: T0 + HOUR }, [], kinds)).toEqual([]);
  });

  test("a group span is blocked when the member list is missing", () => {
    const blocked = unavailableKinds([], -4, { start: T0, end: T0 + HOUR }, [], kinds);
    expect(blocked).toHaveLength(kinds.length);
    expect(blocked[0]?.reason).toContain("devices");
  });
});

describe("undo", () => {
  test("an add inverts to a remove and back", () => {
    const op: LabelOp = { kind: "add", label: label() };
    expect(invertOp(op)).toEqual({ kind: "remove", label: label() });
    expect(invertOp(invertOp(op))).toEqual(op);
  });

  test("an update inverts by swapping its sides", () => {
    const before = label({ kind: "stationary" });
    const after = label({ kind: "walk" });
    expect(invertOp({ kind: "update", before, after })).toEqual({ kind: "update", before: after, after: before });
  });

  test("undo pops the most recent operation", () => {
    const first: LabelOp = { kind: "add", label: label({ id: "a" }) };
    const second: LabelOp = { kind: "add", label: label({ id: "b" }) };
    const history = pushOp(pushOp([], first), second);
    const popped = popUndo(history);
    expect(popped.op).toBe(second);
    expect(popped.history).toEqual([first]);
    expect(popUndo([]).op).toBeNull();
  });

  test("applying an op reaches the store", () => {
    const calls: string[] = [];
    const io: LabelIo = {
      add: (written) => { calls.push(`add:${written.id}`); },
      update: (written) => { calls.push(`update:${written.id}`); return true; },
      remove: (entityId, id) => { calls.push(`remove:${entityId}:${id}`); return true; },
    };

    applyOp({ kind: "add", label: label({ id: "a" }) }, io);
    applyOp({ kind: "update", before: label({ id: "a" }), after: label({ id: "a", kind: "bike" }) }, io);
    applyOp({ kind: "remove", label: label({ id: "a" }) }, io);
    expect(calls).toEqual(["add:a", "update:a", "remove:1:a"]);
  });
});
