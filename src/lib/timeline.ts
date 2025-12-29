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
