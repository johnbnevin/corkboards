/**
 * Backup-flush registry.
 *
 * Lets the account-switch choke point (useLoggedInAccounts.setLogin — the same
 * path the header AccountSwitcher and the mobile-viewport menu both use) flush
 * any pending cloud (Blossom) backup for the DEPARTING account before swapping,
 * matching the safety the logout path already has. We can't pull the heavy
 * useNostrBackup hook into useLoggedInAccounts, so MultiColumnClient registers
 * the real flush here and the switch awaits it.
 *
 * Note: switchActiveUser already stashes the departing user's data locally
 * (namespaced per-pubkey), so local follows/settings are never lost on a switch.
 * This only ensures the last edits also reach the cloud backup before we leave.
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
