/**
 * userZapCache — session-scoped record of notes the current user has zapped.
 *
 * Mirrors web's `recordUserZap` optimistic pattern (NoteCard.tsx): once the
 * user sends a zap we want the UI to reflect the zapped state immediately,
 * without waiting for the zap-receipt (kind 9735) to propagate back through
 * the engagement query. This is a tiny module-level Set — it intentionally
 * does not persist across app restarts.
 */
const zappedNoteIds = new Set<string>();

/** Mark a note as zapped by the current user for this session. */
export function recordUserZap(noteId: string): void {
  zappedNoteIds.add(noteId);
}

/** True if the current user has zapped this note during this session. */
export function hasUserZapped(noteId: string): boolean {
  return zappedNoteIds.has(noteId);
}

/** Clear all session zap state. Call on logout to avoid cross-user contamination. */
export function clearUserZapCache(): void {
  zappedNoteIds.clear();
}
