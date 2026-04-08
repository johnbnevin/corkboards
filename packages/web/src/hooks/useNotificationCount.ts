/**
 * useNotificationCount — lightweight background query that counts new notifications
 * since the user last visited the notifications tab.
 *
 * Fetches lazily (via requestIdleCallback / 3 s fallback) so it doesn't compete
 * with the initial page load. Refreshes every 60 s while the app is open.
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@/hooks/useNostr';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { STORAGE_KEYS } from '@/lib/storageKeys';

const QUERY_KEY_PREFIX = 'notification-count';
// How far back to look when there's no prior last-seen timestamp (7 days)
const DEFAULT_LOOKBACK_SECS = 7 * 24 * 60 * 60;

export function useNotificationCount() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser(false);
  const queryClient = useQueryClient();

  // Persisted timestamp (unix secs) of when user last opened the notifications tab
  const [lastSeenAt, setLastSeenAt] = useLocalStorage<number>(
    STORAGE_KEYS.NOTIFICATIONS_LAST_SEEN,
    0,
  );

  // Defer first fetch until the browser is idle so we don't race the initial load
  const [idleReady, setIdleReady] = useState(false);
  useEffect(() => {
    if (!user?.pubkey) return;
    if (typeof requestIdleCallback !== 'undefined') {
      const id = requestIdleCallback(() => setIdleReady(true), { timeout: 5000 });
      return () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(() => setIdleReady(true), 3000);
      return () => clearTimeout(id);
    }
  }, [user?.pubkey]);

  const since = lastSeenAt > 0
    ? lastSeenAt
    : Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_SECS;

  const { data: newCount } = useQuery({
    queryKey: [QUERY_KEY_PREFIX, user?.pubkey, since],
    queryFn: async () => {
      if (!user?.pubkey) return 0;
      const events = await nostr.query(
        [{ kinds: [1, 6, 7, 16, 9735], '#p': [user.pubkey], since, limit: 50 }],
        { signal: AbortSignal.timeout(8000) },
      );
      return events.filter(e => e.pubkey !== user.pubkey).length;
    },
    enabled: idleReady && !!user?.pubkey,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  /** Call when user navigates to the notifications tab */
  const markSeen = useCallback(() => {
    const now = Math.floor(Date.now() / 1000);
    setLastSeenAt(now);
    // Immediately invalidate so count resets without waiting for next refetch
    queryClient.invalidateQueries({ queryKey: [QUERY_KEY_PREFIX, user?.pubkey] });
  }, [setLastSeenAt, queryClient, user?.pubkey]);

  return { newCount: newCount ?? 0, markSeen };
}
