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
  chains.set(key, result.then(() => {}, () => {}));
  return result;
}
