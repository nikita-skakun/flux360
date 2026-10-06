import { isPointKind } from "./types";
import type { Label, LabelKind } from "./types";

export type PlacementCheck =
  | { ok: true }
  | { ok: false; reason: string; conflictId: string | null };

/**
 * Decides whether a label may be written.
 *
 * Segment labels may touch at a boundary but never overlap, since two spans claiming
 * different things about the same instant is a contradiction rather than a preference.
 * Point labels are exempt, because an outlier sits inside a span by design. The caller
 * must pass the existing labels without the one being edited.
 */
export function checkPlacement(existing: Label[], candidate: Label): PlacementCheck {
  if (candidate.deviceId < 0 && !candidate.memberDeviceIds?.length) {
    return { ok: false, reason: "a group label must record the devices it was made against", conflictId: null };
  }

  if (candidate.end < candidate.start) {
    return { ok: false, reason: "a label cannot end before it starts", conflictId: null };
  }

  if (isPointKind(candidate.kind)) {
    const duplicate = existing.find(
      other => other.kind === candidate.kind && other.start === candidate.start && other.end === candidate.end
    );
    if (duplicate) {
      return { ok: false, reason: `this fix is already labelled ${candidate.kind}`, conflictId: duplicate.id };
    }
    return { ok: true };
  }

  for (const other of existing) {
    if (isPointKind(other.kind)) continue;
    if (candidate.start < other.end && other.start < candidate.end) {
      return { ok: false, reason: `overlaps an existing ${other.kind} label`, conflictId: other.id };
    }
  }

  return { ok: true };
}

/**
 * Which kinds the given span cannot take, with the reason for each.
 *
 * The client holds every label for the entity, so overlap can be decided locally
 * instead of discovered by the server after the label has already been drawn. Purely a
 * convenience: the server runs the same check and remains the authority.
 */
export function unavailableKinds(
  existing: Label[],
  deviceId: number,
  span: { start: number; end: number },
  memberDeviceIds: number[],
  kinds: readonly LabelKind[]
): { kind: LabelKind; reason: string }[] {
  const unavailable: { kind: LabelKind; reason: string }[] = [];
  for (const kind of kinds) {
    const candidate: Label = {
      id: "placement-probe",
      deviceId,
      kind,
      start: span.start,
      end: span.end,
      createdAt: 0,
      ...(deviceId < 0 ? { memberDeviceIds } : {}),
    };
    const check = checkPlacement(existing, candidate);
    if (!check.ok) unavailable.push({ kind, reason: check.reason });
  }
  return unavailable;
}
