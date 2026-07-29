/**
 * The event side of backup change detection — mirror of web's lib/backupDirty.
 *
 * MmkvStorage calls `notifyBackupDirty` from its write choke point whenever a
 * SNAPSHOT_KEY changes, so no mutation path can forget to mark the backup
 * dirty. Events only SCHEDULE a save check; `hasUnsavedChanges()` remains the
 * arbiter of whether anything actually needs saving.
 */

type DirtyListener = (key: string) => void;

const listeners = new Set<DirtyListener>();

export function registerBackupDirtyListener(fn: DirtyListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function notifyBackupDirty(key: string): void {
  for (const fn of listeners) {
    try { fn(key); } catch { /* one listener must not break the write path */ }
  }
}
