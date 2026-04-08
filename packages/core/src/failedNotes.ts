/**
 * Deferred retry queue for note IDs that failed to load.
 *
 * When a relay doesn't have a referenced note at fetch time (e.g. a reply
 * references a parent that hasn't propagated yet), the note ID is registered
 * here. After the page settles, MultiColumnClient drains the queue and
 * retries via a targeted relay query.
 *
 * This is a write-once-then-drain queue: `getFailedNoteIds()` returns all
 * accumulated IDs and clears the set in one atomic operation (drain-on-read).
 */

const failedNoteIds = new Set<string>()

/** Register a note ID for deferred retry. Idempotent — duplicates are ignored. */
export function registerFailedNote(noteId: string): void {
  failedNoteIds.add(noteId)
}

/**
 * Drain and return all accumulated failed note IDs.
 * The internal set is cleared after this call — each ID is only retried once.
 */
export function getFailedNoteIds(): string[] {
  const ids = Array.from(failedNoteIds)
  failedNoteIds.clear()
  return ids
}
