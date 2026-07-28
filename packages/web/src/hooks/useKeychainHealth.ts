/**
 * Desktop-only: detect a signing key that is no longer in the OS keychain.
 *
 * ## Why this exists
 *
 * On desktop an `nsec` login stores the key in the OS keychain and then BLANKS
 * the copy in the login record, so the keychain is the only remaining copy. If
 * that entry disappears, nothing announces it: `signer.rs` returns "no key in
 * keychain for this pubkey" for every sign and encrypt, and the user just sees
 * posting, reacting, zapping and backup all fail for no stated reason.
 *
 * That was not hypothetical. The Linux build asked the `keyring` crate for its
 * `linux-native` backend, which is kernel keyutils — *volatile*, cleared on
 * reboot. Every Linux user who logged in with an nsec, did not keep their own
 * copy, and rebooted lost the key outright. The backend is now the persistent
 * Secret Service one, but that fixes the future, not the machines this already
 * happened on, and a locked keyring or a keychain the app cannot reach produces
 * the same silence.
 *
 * So: check once at startup, per logged-in nsec account, and say plainly what
 * happened. Read-only — this never deletes a login or touches the keychain. The
 * user decides whether to re-import the key or remove the account, because a
 * locked keyring is temporary and quietly discarding their account over it
 * would turn a recoverable state into a permanent one.
 */
import { useEffect, useState } from 'react';
import { useNostrLogin } from '@nostrify/react/login';
import { isTauri, keychainHasKey } from '@/lib/tauri';

export interface KeychainHealth {
  /** Pubkeys of nsec logins whose keychain entry is missing. */
  missingKeyPubkeys: string[];
  /** True once the check has run (or been skipped as not applicable). */
  checked: boolean;
}

export function useKeychainHealth(): KeychainHealth {
  const { logins } = useNostrLogin();
  const [missingKeyPubkeys, setMissing] = useState<string[]>([]);
  const [checked, setChecked] = useState(!isTauri);

  // Only the identity of the nsec logins matters; re-running on every logins
  // array identity change would re-query the keychain on unrelated renders.
  const nsecPubkeys = logins
    .filter((l) => l.type === 'nsec')
    .map((l) => l.pubkey)
    .join(',');

  useEffect(() => {
    if (!isTauri) return;
    const pubkeys = nsecPubkeys ? nsecPubkeys.split(',') : [];
    if (pubkeys.length === 0) {
      setMissing([]);
      setChecked(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        pubkeys.map(async (pubkey) => ({ pubkey, present: await keychainHasKey(pubkey) })),
      );
      if (cancelled) return;
      setMissing(results.filter((r) => !r.present).map((r) => r.pubkey));
      setChecked(true);
    })();

    return () => { cancelled = true; };
  }, [nsecPubkeys]);

  return { missingKeyPubkeys, checked };
}
