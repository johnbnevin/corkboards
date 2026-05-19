/**
 * useAccountSwitchEffect — detect when a new login is added and, if needed,
 * trigger the active-account switch so the per-user isolation flow runs.
 *
 * @nostrify/react auto-activates new logins, but only when there's a single
 * account. When adding a second (or third+) account, the new pubkey isn't
 * always automatically active — we force the switch here so the rest of
 * the app sees the new user.
 *
 * The actual storage swap + reload is owned by useAccountIsolation (which
 * fires on user.pubkey change). This effect only ensures user.pubkey
 * actually moves.
 *
 * Extracted from MultiColumnClient so the detect-and-switch logic can be
 * tested without rendering the whole 4800-line page.
 */
import { useEffect, useRef } from 'react';

export interface LoginLike {
  id: string;
  pubkey: string;
}

export interface UseAccountSwitchEffectOptions {
  allLogins: readonly LoginLike[];
  /** Currently active user pubkey, or undefined when signed out. */
  pubkey: string | undefined;
  /** Switch to a specific login by id (typically `useLoggedInAccounts().setLogin`). */
  switchToAccount: (id: string) => void;
  /** Called whenever a new account is detected — used to close any "add account" dialog. */
  onAccountAdded?: () => void;
}

export function useAccountSwitchEffect({
  allLogins,
  pubkey,
  switchToAccount,
  onAccountAdded,
}: UseAccountSwitchEffectOptions): void {
  const prevLoginCountRef = useRef(allLogins.length);
  const prevUserPubkeyRef = useRef(pubkey);

  useEffect(() => {
    const prevCount = prevLoginCountRef.current;
    const prevPubkey = prevUserPubkeyRef.current;
    prevLoginCountRef.current = allLogins.length;
    prevUserPubkeyRef.current = pubkey;

    // Detect new login added with multiple accounts present
    if (allLogins.length > prevCount && allLogins.length > 1) {
      onAccountAdded?.();
      // Storage swap + reload is handled by useAccountIsolation when user.pubkey
      // changes. If @nostrify/react hasn't auto-activated the new login yet,
      // switchToAccount triggers the pubkey change.
      const alreadySwitched = pubkey && pubkey !== prevPubkey && prevPubkey;
      if (!alreadySwitched) {
        const newestLogin = allLogins[allLogins.length - 1];
        if (newestLogin) switchToAccount(newestLogin.id);
      }
    }
  }, [allLogins, pubkey, switchToAccount, onAccountAdded]);
}
