/**
 * Backup indicator state as a tiny module store (mobile parity with web's
 * BackupIndicatorIcon states). AutoSaveManager is headless, so the state has
 * to live outside a component for the header dot to subscribe to it.
 *
 *   idle    — nothing to report (dot hidden)
 *   unsaved — changes waiting to upload (red)
 *   saving  — upload in flight (orange, pulsing — same #f97316 as New Post)
 *   saved   — last upload succeeded (green)
 *   error   — last upload failed (red)
 */

export type BackupIndicatorState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

let _state: BackupIndicatorState = 'idle';
const listeners = new Set<() => void>();

export function setBackupIndicatorState(next: BackupIndicatorState): void {
  if (next === _state) return;
  _state = next;
  for (const fn of listeners) fn();
}

export function getBackupIndicatorState(): BackupIndicatorState {
  return _state;
}

export function subscribeBackupIndicator(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
