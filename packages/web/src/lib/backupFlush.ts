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

/** Upper bound on the pre-switch flush.
 *
 *  The flush encrypts with the DEPARTING account's signer, and for a NIP-46
 *  account that is a remote round trip needing its own approval. During an
 *  Amber add-account on Android the app has just been backgrounded by the
 *  signer app and its relay sockets may be dead — awaiting the flush
 *  unbounded left the login stuck on "opening amber, approve the connection…"
 *  forever. A missed cloud flush only delays the backup (the local per-user
 *  stash is untouched and the next autosave retries); a wedged login loses
 *  the user. */
const FLUSH_TIMEOUT_MS = 15_000;

/** Await the registered backup flush (best-effort — never blocks a switch). */
export async function flushBackupBeforeSwitch(): Promise<void> {
  if (!flushFn) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flushFn(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, FLUSH_TIMEOUT_MS); }),
    ]);
  } catch {
    /* best-effort: a failed/absent backup must never block account switching */
  } finally {
    clearTimeout(timer);
  }
}
