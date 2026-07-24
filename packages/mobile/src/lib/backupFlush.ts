/**
 * Backup-flush registry (mobile mirror of web's lib/backupFlush).
 *
 * Lets AuthContext.switchAccount flush any pending cloud (Blossom) backup for
 * the departing account before swapping, matching logout's safety. AutoSaveManager
 * (which holds the backup hook) registers the real flush; switchAccount awaits it.
 * switchActiveUser already stashes local data per-pubkey, so this only ensures the
 * last edits reach the cloud backup before we leave the account.
 */
type FlushFn = () => Promise<void>;

let flushFn: FlushFn | null = null;

export function registerBackupFlush(fn: FlushFn | null): void {
  flushFn = fn;
}

/** Await the registered backup flush (best-effort — never blocks a switch). */
export async function flushBackupBeforeSwitch(): Promise<void> {
  if (!flushFn) return;
  try {
    await flushFn();
  } catch {
    /* best-effort: a failed/absent backup must never block account switching */
  }
}
