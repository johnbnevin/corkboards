/**
 * useNotificationCount — lightweight background query that counts new notifications
 * since the user last visited the notifications tab.
 *
 * Port of packages/web/src/hooks/useNotificationCount.ts for mobile.
 * Uses MMKV instead of IDB for persisted last-seen timestamp.
 */
import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { mobileStorage } from '../storage/MmkvStorage';
import { STORAGE_KEYS } from '../lib/storageKeys';

const QUERY_KEY_PREFIX = 'notification-count';
const DEFAULT_LOOKBACK_SECS = 7 * 24 * 60 * 60;

function getLastSeenAt(): number {
  try {
    const stored = mobileStorage.getSync(STORAGE_KEYS.NOTIFICATIONS_LAST_SEEN);
    return stored ? parseInt(stored, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function setLastSeenAtStorage(ts: number): void {
  try {
    mobileStorage.setSync(STORAGE_KEYS.NOTIFICATIONS_LAST_SEEN, String(ts));
  } catch { /* ignore */ }
}

export function useNotificationCount() {
  const { nostr } = useNostr();
  const { pubkey } = useAuth();
  const queryClient = useQueryClient();

  const [lastSeenAt, setLastSeenAtState] = useState(() => getLastSeenAt());

  // Defer first fetch so it doesn't compete with initial feed load
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!pubkey) return;
    const id = setTimeout(() => setReady(true), 3000);
    return () => clearTimeout(id);
  }, [pubkey]);

  const since = lastSeenAt > 0
    ? lastSeenAt
    : Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_SECS;

  const { data: newCount } = useQuery({
    queryKey: [QUERY_KEY_PREFIX, pubkey, since],
    queryFn: async () => {
      if (!pubkey) return 0;
      const events = await nostr.query(
        [{ kinds: [1, 6, 7, 16, 9735], '#p': [pubkey], since, limit: 50 }],
        { signal: AbortSignal.timeout(8000) },
      );
      return events.filter(e => e.pubkey !== pubkey).length;
    },
    enabled: ready && !!pubkey,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const markSeen = useCallback(() => {
    const now = Math.floor(Date.now() / 1000);
    setLastSeenAtState(now);
    setLastSeenAtStorage(now);
    queryClient.invalidateQueries({ queryKey: [QUERY_KEY_PREFIX, pubkey] });
  }, [queryClient, pubkey]);

  return { newCount: newCount ?? 0, markSeen };
}
