import { cosLatitude, fromWebMercator, metricDistance, toWebMercator } from "@/util/webMercator";
import { isPointKind } from "./types";
import type { Label, LabelKind, StripFix } from "./types";
import type { Vec2 } from "@/types";

/**
 * The strip works on raw fixes rather than engine output, because a label is a
 * statement about what happened, and the derivation is the thing being judged. For a
 * group the fixes are the union of its members, which is also exactly what the group
 * engine consumes.
 */
/** How much history one strip page loads. Scrolling past the left edge loads the previous chunk. */
export const LABEL_CHUNK_MS = 3 * 24 * 60 * 60 * 1000;

export function mergeFixes(existing: StripFix[], incoming: StripFix[]): StripFix[] {
  const byKey = new Map<string, StripFix>();
  for (const fix of existing) byKey.set(`${fix.device}:${fix.timestamp}`, fix);
  for (const fix of incoming) byKey.set(`${fix.device}:${fix.timestamp}`, fix);
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function firstIndexAtOrAfter(fixes: StripFix[], timestamp: number): number {
  let low = 0;
  let high = fixes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const fix = fixes[mid];
    if (fix && fix.timestamp < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

export type LabelRange = { label: Label; first: number; last: number };

/** The fix indices a label covers, clamped to what is loaded. Point kinds included. */
export function labelFixRange(fixes: StripFix[], label: Label): { first: number; last: number } | null {
  const first = firstIndexAtOrAfter(fixes, label.start);
  const firstFix = fixes[first];
  if (!firstFix || firstFix.timestamp > label.end) return null;
  const afterLast = firstIndexAtOrAfter(fixes, label.end + 1);
  return { first, last: Math.max(first, afterLast - 1) };
}

/** How many empty pages the strip steps over before it stops reaching back. */
export const MAX_EMPTY_PAGES = 40;

export type PageLoader = (from: number, to: number) => Promise<number>;

/**
 * Steps backwards a page at a time until a page yields fixes.
 *
 * An empty page is a gap in reporting, not the end of the history. Devices that go quiet
 * for a week and report again are ordinary, so treating the first empty page as the end
 * stranded the strip on the last run of fixes with no way further back. The allowance
 * keeps a device with no history at all from being walked to the beginning of time.
 *
 * Returns the start of the oldest page reached, whether or not it held anything.
 */
export async function walkBackForFixes(anchorFrom: number, loadPage: PageLoader): Promise<number> {
  let from = anchorFrom;
  for (let page = 0; page < MAX_EMPTY_PAGES; page += 1) {
    const to = from;
    from = to - LABEL_CHUNK_MS;
    if (await loadPage(from, to) > 0) break;
  }
  return from;
}

export type AccuracyBlob = { geo: Vec2; radiusMeters: number; count: number };

/** Blobs are no smaller than this, however tight the fixes are. */
const MIN_CELL_METERS = 12;
/** Bucket size as a multiple of the typical accuracy, so dense and sparse channels both behave. */
const CELL_ACCURACY_FACTOR = 2;

function medianAccuracy(fixes: StripFix[]): number {
  const sorted = fixes.map(fix => fix.accuracy).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? MIN_CELL_METERS;
}

/**
 * Collapses fixes into one circle per neighbourhood.
 *
 * MapLibre composites every GeoJSON feature separately, so a few hundred overlapping
 * translucent circles at the same place do not average out: they accumulate, and a
 * parked cluster renders as a saturated white disc with a bright core. Nothing about
 * the opacity fixes that, because the count is the problem. Merging fixes onto a grid
 * bounds the feature count and keeps the circles from stacking, while fixes that are
 * genuinely apart still get their own circle.
 *
 * A grid rather than greedy merging on purpose: greedy merging chains, so a slow walk
 * with fixes closer together than their own accuracy would collapse an entire track
 * into one enormous circle.
 */
export function mergeAccuracyCircles(fixes: StripFix[]): AccuracyBlob[] {
  if (fixes.length === 0) return [];

  const cell = Math.max(MIN_CELL_METERS, medianAccuracy(fixes) * CELL_ACCURACY_FACTOR);
  // The cell is in ground metres, but Web Mercator stretches both axes by sec(latitude),
  // so bucketing raw projected units would shrink the cell by cos(latitude) and merge
  // far less than intended.
  const scale = cosLatitude(toWebMercator(fixes[0]!.geo)[1]);
  const buckets = new Map<string, StripFix[]>();

  for (const fix of fixes) {
    const [x, y] = toWebMercator(fix.geo);
    const key = `${Math.floor((x * scale) / cell)}:${Math.floor((y * scale) / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(fix);
    else buckets.set(key, [fix]);
  }

  const blobs: AccuracyBlob[] = [];
  for (const members of buckets.values()) {
    let sumX = 0;
    let sumY = 0;
    for (const fix of members) {
      const [x, y] = toWebMercator(fix.geo);
      sumX += x;
      sumY += y;
    }
    const centre: Vec2 = [sumX / members.length, sumY / members.length];

    // The radius has to contain every member's own accuracy circle, or the blob would
    // claim to know the position better than the fixes say.
    let radiusMeters = 0;
    for (const fix of members) {
      const reach = metricDistance(centre, toWebMercator(fix.geo)) + fix.accuracy;
      if (reach > radiusMeters) radiusMeters = reach;
    }

    blobs.push({ geo: fromWebMercator(centre), radiusMeters, count: members.length });
  }
  return blobs;
}

/**
 * Maps each segment label onto the fix indices it covers. Point labels are excluded:
 * an outlier is drawn on its own fix, not as a span.
 */
export function labelsCovering(fixes: StripFix[], labels: Label[]): LabelRange[] {
  const ranges: LabelRange[] = [];
  for (const label of labels) {
    if (isPointKind(label.kind)) continue;
    const range = labelFixRange(fixes, label);
    if (range) ranges.push({ label, first: range.first, last: range.last });
  }
  return ranges.sort((a, b) => a.first - b.first);
}

/**
 * The indices that carry a white seam. A boundary is shared by the label that ends
 * there and the one that starts there, so both ends land on the same fix.
 */
export function labelBoundaryIndices(fixes: StripFix[], labels: Label[]): number[] {
  const indices = new Set<number>();
  for (const range of labelsCovering(fixes, labels)) {
    indices.add(range.first);
    indices.add(range.last);
  }
  return [...indices].sort((a, b) => a - b);
}

/** The label drawn on a fix. At a shared boundary the later-starting label wins. */
export function labelAtFix(ranges: LabelRange[], fixes: StripFix[], index: number): Label | null {
  const fix = fixes[index];
  if (!fix) return null;
  let found: Label | null = null;
  for (const range of ranges) {
    if (index >= range.first && index <= range.last) found = range.label;
  }
  return found;
}

/**
 * The kind of label each fix belongs to, or null where nothing claims it. Point labels
 * win over the span they sit in, because an outlier is a statement about that one fix.
 */
export function kindsAtFixes(fixes: StripFix[], labels: Label[]): (LabelKind | null)[] {
  const ranges = labelsCovering(fixes, labels);
  const outliers = new Set(labels.filter(label => label.kind === "outlier").map(label => label.start));
  return fixes.map((fix, index) =>
    outliers.has(fix.timestamp) ? "outlier" : labelAtFix(ranges, fixes, index)?.kind ?? null
  );
}

/**
 * The fix whose drawn circle covers the point, nearest centre first.
 *
 * Hit tested in ground coordinates rather than through the layer's own feature index,
 * because the circles are merged and their drawn size is floored in screen pixels, so
 * what is on screen is deliberately not what is in the data.
 */
export function fixAtPoint(fixes: StripFix[], point: Vec2, minReachMeters: number): StripFix | null {
  let best: StripFix | null = null;
  let bestDistance = Infinity;
  for (const fix of fixes) {
    const reach = Math.max(fix.accuracy, minReachMeters);
    const distance = metricDistance(point, toWebMercator(fix.geo));
    if (distance <= reach && distance < bestDistance) {
      best = fix;
      bestDistance = distance;
    }
  }
  return best;
}

export function outlierAt(fixes: StripFix[], labels: Label[], index: number): boolean {
  const fix = fixes[index];
  if (!fix) return false;
  return labels.some(label => label.kind === "outlier" && label.start === fix.timestamp);
}
