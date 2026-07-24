/**
 * Per-key async mutex. Serializes async critical sections that share a key so
 * concurrent read-modify-write cycles (e.g. "load older" while a background
 * refetch resolves) can't interleave and clobber each other's writes. (C3)
 *
 * Pure/platform-agnostic — no DOM, storage, or React deps.
 */
const chains = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Wait for the previous op to fully settle, then run ours.
  const result = prev.then(() => fn());
  // Store a rejection-swallowed tail so the NEXT waiter never sees a rejected
  // predecessor (its own errors still propagate to its own caller via `result`).
  const tail = result.then(() => {}, () => {});
  chains.set(key, tail);
  // Drop the entry once this op is the last one queued for the key, so the map
  // doesn't retain a settled promise per key for the life of the process.
  // Guarded on identity: if another caller chained onto us while we ran, the
  // map now holds THEIR tail and deleting it would let a third caller start
  // concurrently with them — the exact interleaving this lock exists to prevent.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}
