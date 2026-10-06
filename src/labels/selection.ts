/**
 * Selection model for the strip.
 *
 * The selection is held as fix indices rather than screen positions, so it survives
 * scrolling the anchor out of view. Everything downstream works on the range, never on
 * a materialised list of indices, because a group can hold six figures of fixes.
 */
export type StripSelection = {
  anchor: number | null;
  head: number | null;
};

export type TimedPoint = { timestamp: number };

export const EMPTY_SELECTION: StripSelection = { anchor: null, head: null };

/** Marking outliers one span at a time is not offered, so a huge range is refused. */
export const OUTLIER_BULK_LIMIT = 200;

export function selectPoint(index: number): StripSelection {
  return { anchor: index, head: index };
}

/**
 * A plain click. Clicking the fix that is already the entire selection clears it, which
 * is the only way to deselect; clicking anything else selects just that fix, even when
 * a range is currently selected.
 */
export function togglePoint(selection: StripSelection, index: number): StripSelection {
  const range = selectionRange(selection);
  if (range && range.from === index && range.to === index) return EMPTY_SELECTION;
  return selectPoint(index);
}

export function extendSelection(selection: StripSelection, index: number): StripSelection {
  if (selection.anchor === null) return selectPoint(index);
  return { anchor: selection.anchor, head: index };
}

export function selectionRange(selection: StripSelection): { from: number; to: number } | null {
  if (selection.anchor === null || selection.head === null) return null;
  return selection.anchor <= selection.head
    ? { from: selection.anchor, to: selection.head }
    : { from: selection.head, to: selection.anchor };
}

export function isIndexSelected(selection: StripSelection, index: number): boolean {
  const range = selectionRange(selection);
  return range !== null && index >= range.from && index <= range.to;
}

export function selectionCount(selection: StripSelection): number {
  const range = selectionRange(selection);
  return range === null ? 0 : range.to - range.from + 1;
}

function clampedRange(selection: StripSelection, total: number): { from: number; to: number } | null {
  const range = selectionRange(selection);
  if (range === null || total === 0) return null;
  if (range.from >= total) return null;
  return { from: Math.max(0, range.from), to: Math.min(total - 1, range.to) };
}

export function selectionWindow(
  selection: StripSelection,
  fixes: TimedPoint[]
): { start: number; end: number; count: number } | null {
  const range = clampedRange(selection, fixes.length);
  if (range === null) return null;
  const first = fixes[range.from];
  const last = fixes[range.to];
  if (!first || !last) return null;
  return { start: first.timestamp, end: last.timestamp, count: range.to - range.from + 1 };
}

export function selectedFixes<T extends TimedPoint>(selection: StripSelection, fixes: T[]): T[] {
  const range = clampedRange(selection, fixes.length);
  if (range === null) return [];
  return fixes.slice(range.from, range.to + 1);
}

export function outlierTimestamps(selection: StripSelection, fixes: TimedPoint[]): number[] | null {
  const range = clampedRange(selection, fixes.length);
  if (range === null) return null;
  const count = range.to - range.from + 1;
  if (count > OUTLIER_BULK_LIMIT) return null;
  const timestamps: number[] = [];
  for (let index = range.from; index <= range.to; index += 1) {
    const fix = fixes[index];
    if (fix) timestamps.push(fix.timestamp);
  }
  return timestamps;
}
