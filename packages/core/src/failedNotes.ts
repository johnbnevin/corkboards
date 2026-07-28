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
 */

const unresolvedIds = new Set<string>()

/**
 * Bound on tracked ids. The set is unmount-scoped, so it should stay near the
 * count of on-screen references — but a leak here would be silent and would feed
 * an ever-growing retry sweep, so cap it and drop the oldest.
 */
const MAX_UNRESOLVED = 500

/** Mark a note reference as on screen and unresolved. Idempotent. */
export function registerUnresolved(noteId: string): void {
  if (!noteId || unresolvedIds.has(noteId)) return
  if (unresolvedIds.size >= MAX_UNRESOLVED) {
    const oldest = unresolvedIds.values().next().value
    if (oldest !== undefined) unresolvedIds.delete(oldest)
  }
  unresolvedIds.add(noteId)
}

/** Mark a reference as resolved, or gone from the screen. Idempotent. */
export function clearUnresolved(noteId: string): void {
  unresolvedIds.delete(noteId)
}

/** Ids currently unresolved on screen. Non-destructive — safe to poll. */
export function getUnresolvedIds(): string[] {
  return Array.from(unresolvedIds)
}

/** How many references are unresolved right now. */
export function unresolvedCount(): number {
  return unresolvedIds.size
}

/** Drop everything (logout, data wipe, feed replaced). */
export function clearAllUnresolved(): void {
  unresolvedIds.clear()
}
