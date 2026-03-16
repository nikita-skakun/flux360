/**
 * Iterate over a record as numeric key/value pairs.
 */
export function* numericEntries<T>(record: Record<number, T>): IterableIterator<[number, T]> {
  for (const [k, v] of Object.entries(record)) {
    yield [Number(k), v] as const;
  }
}

/**
 * Get the numeric keys of a record.
 */
export function numericKeys(record: Record<number, unknown>): number[] {
  return Object.keys(record).map(k => Number(k));
}
