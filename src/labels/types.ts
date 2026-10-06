import { z } from "zod";

/**
 * What a human asserts about a span of time for one entity.
 *
 * The mode kinds double as movement claims: anything that is not `stationary` or
 * `outlier` asserts the entity was moving. `unknown` therefore means "moved, mode
 * unclear", which is a different statement from having no label at all.
 */
export const LabelKindSchema = z.enum([
  "stationary",
  "walk",
  "run",
  "bike",
  "car",
  "bus",
  "train",
  "plane",
  "boat",
  "unknown",
  "outlier",
  "waypoint",
]);
export type LabelKind = z.infer<typeof LabelKindSchema>;

const SEGMENT_KINDS = new Set<LabelKind>([
  "stationary", "walk", "run", "bike", "car", "bus", "train", "plane", "boat", "unknown",
]);
const POINT_KINDS = new Set<LabelKind>(["outlier", "waypoint"]);

export function isPointKind(kind: LabelKind): boolean {
  return POINT_KINDS.has(kind);
}

export function isMotionKind(kind: LabelKind): boolean {
  return SEGMENT_KINDS.has(kind) && kind !== "stationary";
}

/**
 * A label is a statement about a span of time for one entity. A group is just an
 * entity with a negative id, the same convention the engine already uses.
 *
 * `start` and `end` are the span the statement covers.
 *
 * A point claim is a degenerate span. `outlier` marks a single fix as bad. `waypoint`
 * is a known location the entity passed through, and its span is the window in which
 * it did so, which may be wide when the time is not known.
 *
 * A group label records the member devices it was made against, so that adding a
 * device to the group later does not silently change what the label claims.
 */
export const LabelSchema = z.object({
  id: z.string().min(1),
  deviceId: z.number(),
  kind: LabelKindSchema,
  start: z.number(),
  end: z.number(),
  geo: z.tuple([z.number(), z.number()]).optional(),
  memberDeviceIds: z.array(z.number()).optional(),
  note: z.string().optional(),
  createdAt: z.number(),
});

export const StripFixSchema = z.object({
  device: z.number(),
  geo: z.tuple([z.number(), z.number()]),
  accuracy: z.number(),
  timestamp: z.number(),
});
export type StripFix = z.infer<typeof StripFixSchema>;

export type Label = z.infer<typeof LabelSchema>;
