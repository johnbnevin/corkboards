/**
 * Live registry of referenced notes that are on screen but have not resolved.
 *
 * A note reference (a quoted note, a thread parent, an naddr) can fail to load
 * because the relay holding it was slow, briefly unreachable, or — on the
 * desktop build — because a feed fan-out had taken every socket permit. None of
 * those are permanent, so the reference is worth retrying.
 *
 * ## Why a live set and not a drain-on-read queue
 *
 * This used to be write-once-then-drain: `getFailedNoteIds()` returned the
 * accumulated ids AND cleared the set, and a single 15-second timer on page load
 * was its only consumer. So every unresolved reference got exactly one retry,
 * ever — anything that failed after that moment, or failed the retry itself,
 * stayed a grey placeholder until the app was reloaded.
 *
 * A repeating sweep needs to answer a different question: how many references
 * are unresolved *right now*. Draining destroys that answer, and clearing on
 * unmount is what keeps it about the current page rather than about everything
 * the session has ever seen. So entries live until the reference resolves or
 * leaves the screen, and reads are non-destructive.
 *
 * ## Attempts and giving up
 *
 * Each entry carries how many sweeps have tried it. Reads sort by attempts
 * (fewest first) so a batch-capped sweep rotates through everything instead of
 * hammering the first N registered forever, and an id past MAX_SWEEP_ATTEMPTS
 * stops being reported at all — a session left open for days must not retry
 * the same dead reference every 30 seconds for its whole lifetime. Giving up
 * is unmount-scoped: `clearUnresolved` deletes the record, so the count starts
 * fresh when the reference next appears on screen.
 */

import { MAX_SWEEP_ATTEMPTS } from './unresolvedSweep'

/** id → sweep attempts so far. Insertion order is registration order. */
const unresolved = new Map<string, number>()

/**
 * Bound on tracked ids. The map is unmount-scoped, so it should stay near the
 * count of on-screen references — but a leak here would be silent and would feed
 * an ever-growing retry sweep, so cap it and drop the oldest.
 */
const MAX_UNRESOLVED = 500

/** Mark a note reference as on screen and unresolved. Idempotent — a
 *  re-registration keeps the existing attempt count. */
export function registerUnresolved(noteId: string): void {
  if (!noteId || unresolved.has(noteId)) return
  if (unresolved.size >= MAX_UNRESOLVED) {
    const oldest = unresolved.keys().next().value
    if (oldest !== undefined) unresolved.delete(oldest)
  }
  unresolved.set(noteId, 0)
}

/** Mark a reference as resolved, or gone from the screen. Idempotent. */
export function clearUnresolved(noteId: string): void {
  unresolved.delete(noteId)
}

/**
 * Ids still worth retrying, fewest attempts first (ties keep registration
 * order). Non-destructive — safe to poll. Exhausted ids are omitted, so a
 * caller taking the first N gets rotation and give-up for free.
 */
export function getUnresolvedIds(): string[] {
  return Array.from(unresolved.entries())
    .filter(([, attempts]) => attempts < MAX_SWEEP_ATTEMPTS)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id)
}

/** How many references are unresolved and still worth retrying. */
export function unresolvedCount(): number {
  let count = 0
  for (const attempts of unresolved.values()) {
    if (attempts < MAX_SWEEP_ATTEMPTS) count++
  }
  return count
}

/** How many references have been given up on (still on screen, out of tries). */
export function exhaustedCount(): number {
  return unresolved.size - unresolvedCount()
}

/** Record that a sweep just tried these ids. Unknown ids are ignored. */
export function recordSweepAttempts(noteIds: readonly string[]): void {
  for (const id of noteIds) {
    const attempts = unresolved.get(id)
    if (attempts !== undefined) unresolved.set(id, attempts + 1)
  }
}

/** Drop everything (logout, data wipe, feed replaced). */
export function clearAllUnresolved(): void {
  unresolved.clear()
}
