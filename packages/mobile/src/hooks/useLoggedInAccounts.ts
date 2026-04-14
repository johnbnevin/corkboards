/**
 * useLoggedInAccounts — multi-account management for mobile.
 * Mobile port of packages/web/src/hooks/useLoggedInAccounts.ts.
 *
 * Differences from web:
 * - Uses mobile AuthContext instead of @nostrify/react's useNostrLogin
 * - AuthContext already provides accounts (pubkey[]), switchAccount, removeAccount
 * - No window.location.reload() — React Native re-renders via state change
 */
import { useCallback } from 'react';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { NSchema as n } from '@nostrify/nostrify';
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { pubkey: activePubkey, accounts, switchAccount, removeAccount } = useAuth();

  const { data: authors = [] } = useQuery({
    queryKey: ['nostr', 'logins', accounts.join(';')],
    queryFn: async ({ signal }) => {
      if (accounts.length === 0) return [];

      const events = await nostr.query(
        [{ kinds: [0], authors: accounts }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) },
      );

      return accounts.map((pubkey): Account => {
        const event = events.find((e) => e.pubkey === pubkey);
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event?.content);
          return { id: pubkey, pubkey, metadata, event };
        } catch {
          return { id: pubkey, pubkey, metadata: {}, event };
        }
      });
    },
    enabled: accounts.length > 0,
    retry: 3,
  });

  // Current user is the active account
  const currentUser: Account | undefined = (() => {
    if (!activePubkey) return undefined;
    const author = authors.find((a) => a.pubkey === activePubkey);
    return author ?? { id: activePubkey, pubkey: activePubkey, metadata: {} };
  })();

  // Other users are all accounts except the active one
  const otherUsers = authors.filter((a) => a.pubkey !== activePubkey);

  // Wrap switchAccount to match the web's setLogin(id) signature
  const setLogin = useCallback(async (accountId: string) => {
    // On mobile, account id === pubkey
    if (accountId !== activePubkey) {
      await switchAccount(accountId);
    }
  }, [activePubkey, switchAccount]);

  return {
    logins: authors,
    authors,
    currentUser,
    otherUsers,
    setLogin,
    removeLogin: removeAccount,
  };
}
