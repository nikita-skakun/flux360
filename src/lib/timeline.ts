/**
 * Helper to decide whether the timeline should advance to the new latest timestamp.
 *
 * Rules:
 * - If there is no new latest timestamp, do nothing.
 * - If `current` is null, default to `newLatest`.
 * - If `current` is earlier than the cutoff (expired), advance to `newLatest`.
 * - If the user was previously at the prior latest timestamp (i.e. `current === prevLatest`) and
 *   `newLatest` has advanced beyond `prevLatest`, move to `newLatest`.
 * - Otherwise, keep `current` unchanged.
 */
export function computeNextTimelineTime(
  current: number | null,
  prevLatest: number | null,
  newLatest: number | null,
  cutoff: number
): number | null {
  if (newLatest == null) return current;
  if (current == null) return newLatest;
  if (current < cutoff) return newLatest;
  if (prevLatest != null && newLatest > prevLatest && current === prevLatest) return newLatest;
  return current;
}
