import { HardDrive } from 'lucide-react';

/**
 * The backup indicator's full vocabulary. 'saving' is DERIVED (from
 * backupStatus being encrypting/saving) rather than stored, so the blink
 * covers manual "Save now" and auto-save without every call site having to
 * remember to set it.
 */
export type BackupIndicatorState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

const STATE_CLASS: Record<BackupIndicatorState, string> = {
  idle: '',
  unsaved: 'text-red-500',
  // Same orange as the New Post button, pulsing while the save is in flight —
  // "Save now" used to show nothing at all until the result landed.
  saving: 'text-orange-500 animate-pulse',
  saved: 'text-green-500',
  error: 'text-red-500',
};

/**
 * One icon for every header copy — the two headers used to carry duplicated
 * inline class logic that had already drifted once.
 */
export function BackupIndicatorIcon({ state }: { state: BackupIndicatorState }) {
  return <HardDrive className={`h-4 w-4 transition-colors duration-700 ${STATE_CLASS[state]}`} />;
}
