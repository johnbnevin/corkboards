/**
 * The event side of backup change detection.
 *
 * The storage layer (idb.ts) calls `notifyBackupDirty` from its write choke
 * point whenever a SNAPSHOT_KEY changes — the same architectural argument as
 * tombstones-by-diffing: one choke point, so no mutation path can forget to
 * mark the backup dirty. Detection used to be a 30-second hash poll, which is
 * why a dismissal could sit a full minute before uploading.
 *
 * Events only SCHEDULE a save check; `hasUnsavedChanges()` (the FNV hash
 * against the last-backup baseline) remains the arbiter of whether anything
 * actually needs saving, so a false positive here costs one cheap hash.
 */

type DirtyListener = (key: string) => void

const listeners = new Set<DirtyListener>()

export function registerBackupDirtyListener(fn: DirtyListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function notifyBackupDirty(key: string): void {
  for (const fn of listeners) {
    try { fn(key) } catch { /* one listener must not break the write path */ }
  }
}
