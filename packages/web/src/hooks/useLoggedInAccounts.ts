import { useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery } from '@tanstack/react-query';
import { NSchema as n, NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { switchActiveUser, getActiveUserPubkey } from '@/lib/storageKeys';
import { flushBackupBeforeSwitch } from '@/lib/backupFlush';
import { isTauri, keychainDelete } from '@/lib/tauri';
import { deleteNsec } from '@/lib/webKeyStore';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { logins, setLogin: rawSetLogin, removeLogin: rawRemoveLogin } = useNostrLogin();

  const { data: authors = [] } = useQuery({
    queryKey: ['nostr', 'logins', logins.map((l) => l.id).join(';')],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [0], authors: logins.map((l) => l.pubkey) }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) },
      );

      return logins.map(({ id, pubkey }): Account => {
        const event = events.find((e) => e.pubkey === pubkey);
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event?.content);
          return { id, pubkey, metadata, event };
        } catch {
          return { id, pubkey, metadata: {}, event };
        }
      });
    },
    retry: 3,
  });

  // Current user is the first login
  const currentUser: Account | undefined = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  // Other users are all logins except the current one. Match by id — the
  // authors array is a react-query result whose ORDER can lag the login list
  // (stale cache while the fresh query is in flight), so slice(1) could show
  // the current account as "other" and hide a real one.
  const otherUsers = (authors || []).filter((a) => a.id !== logins[0]?.id) as Account[];

  // Wrap removeLogin so removing an nsec account also deletes its stored key
  // material (OS keychain on Tauri, encrypted IndexedDB entry on web). The
  // AccountSwitcher logout fallback calls this directly, bypassing
  // useLoginActions.logoutAccount which does the same cleanup.
  const removeLogin = useCallback((loginId: string) => {
    const login = logins.find((l) => l.id === loginId);
    if (login?.type === 'nsec') {
      if (isTauri) void keychainDelete(`nsec:${login.pubkey}`);
      else void deleteNsec(login.pubkey).catch(() => {});
    }
    rawRemoveLogin(loginId);
  }, [logins, rawRemoveLogin]);

  // Wrap setLogin to handle per-user localStorage isolation. Async so we can
  // flush the departing account's pending cloud backup before swapping — the
  // same safety the logout path has (switchActiveUser already stashes local
  // data per-pubkey, so this only guards the last edits reaching the cloud).
  const setLogin = useCallback(async (loginId: string) => {
    // The active-user marker — NOT React state — is the authority on who we
    // are switching FROM. The logout flow removes the departing login and then
    // calls this through a closure captured BEFORE the removal, so
    // currentUser?.pubkey could still name the departed account here; passing
    // it to switchActiveUser re-stashed that account with its live keys
    // already cleared, which DELETED the authoritative stash logoutAccount had
    // just written. After a logout the marker is null, and switchActiveUser
    // correctly skips the stash step entirely.
    const oldPubkey = getActiveUserPubkey();
    const newLogin = logins.find(l => l.id === loginId);
    const isSwitch = !!newLogin && oldPubkey !== newLogin.pubkey;
    if (isSwitch) {
      await flushBackupBeforeSwitch();
      switchActiveUser(oldPubkey, newLogin.pubkey);
    }
    rawSetLogin(loginId);
    // Reload to ensure all React state picks up the new localStorage values
    if (isSwitch) {
      // The provider persists the login order from a useEffect, and reloading
      // synchronously here could beat that write — the reorder then never
      // reached localStorage['corkboard:login'], so the app came back up on
      // the OLD account while the per-user storage was already swapped to the
      // new one (the mixed-identity state that looked like a double logout).
      //
      // Wait for the provider's OWN write rather than serializing the list
      // here: a manual write both hard-codes @nostrify's storage format and
      // resurrects just-removed logins (this closure's `logins` predates the
      // logout flow's removeLogin). Poll until the persisted head matches the
      // chosen login, with a bounded fallback so a wedged effect can't block
      // the switch forever.
      const deadline = Date.now() + 1000;
      const reloadWhenPersisted = () => {
        try {
          const raw = localStorage.getItem('corkboard:login');
          const head = raw ? (JSON.parse(raw) as Array<{ id?: string }>)[0]?.id : undefined;
          if (head !== loginId && Date.now() < deadline) {
            setTimeout(reloadWhenPersisted, 25);
            return;
          }
        } catch { /* unreadable — reload now, no worse than before */ }
        window.location.reload();
      };
      reloadWhenPersisted();
    }
  }, [logins, rawSetLogin]);

  return {
    logins,
    authors,
    currentUser,
    otherUsers,
    setLogin,
    removeLogin,
  };
}