/**
 * Iterate over a record as numeric key/value pairs.
 */
export function* numericEntries<T>(record: Record<number, T>): IterableIterator<[number, T]> {
  for (const [k, v] of Object.entries(record)) {
    yield [Number(k), v] as const;
  }
}
