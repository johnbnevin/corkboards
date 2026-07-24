/**
 * NostrSync -- Syncs user's Nostr data (relay list, custom feeds, dismissed notes).
 * Renders nothing -- runs side-effects on mount and when user changes.
 *
 * Port of packages/web/src/components/NostrSync.tsx for React Native.
 * Also integrates custom feeds sync and dismissed notes sync.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { PROFILE_INDEXER_RELAYS } from '@core/relayConstants';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useAppContext } from '../hooks/useAppContext';
import { useNostrCustomFeedsSync } from '../hooks/useNostrCustomFeedsSync';
import { useNostrDismissedSync } from '../hooks/useNostrDismissedSync';
import {
  getBlossomServers, setBlossomServers,
  getBlossomServersUpdatedAt, setBlossomServersUpdatedAt,
  DEFAULT_BLOSSOM_SERVERS,
} from '../hooks/useNostrBackup';

type SyncState = 'idle' | 'syncing' | 'done' | 'error';

interface NostrSyncProps {
  /** If true, render a small status indicator. Otherwise render nothing. */
  showStatus?: boolean;
}

export function NostrSync({ showStatus = false }: NostrSyncProps) {
  const { nostr } = useNostr();
  const { pubkey } = useAuth();
  const { config, updateConfig } = useAppContext();
  const lastQueriedUpdatedAt = useRef<number>(-1);

  // Sync hooks are intentionally called for their side effects (kind:30078
  // subscriptions) even though save/load aren't invoked from this component.
  const { save: _saveFeedsSync, load: _loadFeedsSync } = useNostrCustomFeedsSync();
  const { save: _saveDismissedSync, load: _loadDismissedSync } = useNostrDismissedSync();

  const [relaySyncState, setRelaySyncState] = useState<SyncState>('idle');
  // feeds/dismissed state setters reserved for future wiring (the hooks above
  // already drive the actual sync work).
  const [feedsSyncState, _setFeedsSyncState] = useState<SyncState>('idle');
  const [dismissedSyncState, _setDismissedSyncState] = useState<SyncState>('idle');

  // Sync the user's own Nostr lists from relays (newer-wins): NIP-65 relay list
  // (kind 10002) and Blossom server list (kind 10063). Both fall back to the
  // profile indexers so a fresh device still finds them. Keep in sync with web's
  // MultiColumnClient login sync.
  useEffect(() => {
    if (!pubkey) return;
    if (config.relayMetadata.updatedAt === lastQueriedUpdatedAt.current) return;
    lastQueriedUpdatedAt.current = config.relayMetadata.updatedAt;

    // Fetch the newest replaceable event of `kind` — default pool, then indexers.
    const fetchLatest = async (kind: number): Promise<NostrEvent | null> => {
      try {
        let events = await nostr.query(
          [{ kinds: [kind], authors: [pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) },
        );
        if (events.length === 0) {
          events = await Promise.any(
            PROFILE_INDEXER_RELAYS.map(async (url) => {
              const evs = await nostr.relay(url).query(
                [{ kinds: [kind], authors: [pubkey], limit: 1 }],
                { signal: AbortSignal.timeout(4000) },
              );
              if (evs.length === 0) throw new Error('none');
              return evs;
            }),
          ).catch(() => [] as NostrEvent[]);
        }
        return events.length > 0 ? events[0] : null;
      } catch { return null; }
    };

    const syncLists = async () => {
      setRelaySyncState('syncing');
      // ── Relay list (kind 10002) ──
      try {
        const event = await fetchLatest(10002);
        if (event && event.created_at > config.relayMetadata.updatedAt) {
          const fetchedRelays = event.tags
            .filter(([name]) => name === 'r')
            .map(([_, url, marker]) => ({
              url,
              read: !marker || marker === 'read',
              write: !marker || marker === 'write',
            }));
          if (fetchedRelays.length > 0) {
            updateConfig((current) => ({
              ...current,
              relayMetadata: { relays: fetchedRelays, updatedAt: event.created_at },
            }));
          }
        }
        setRelaySyncState('done');
      } catch (error) {
        console.error('Failed to sync relays from Nostr:', error);
        setRelaySyncState('error');
      }

      // ── Blossom server list (kind 10063) ──
      try {
        const event = await fetchLatest(10063);
        if (event && event.created_at > getBlossomServersUpdatedAt()) {
          const servers = event.tags
            .filter((t) => t[0] === 'server' && t[1])
            .map((t) => (t[1].endsWith('/') ? t[1] : t[1] + '/'))
            .filter((url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } });
          if (servers.length > 0) {
            const merged = [...new Set([...servers, ...DEFAULT_BLOSSOM_SERVERS])];
            if (JSON.stringify(merged) !== JSON.stringify(getBlossomServers())) {
              setBlossomServers(merged);
            }
            setBlossomServersUpdatedAt(event.created_at);
          }
        }
      } catch { /* best-effort */ }
    };

    syncLists();
  }, [pubkey, config.relayMetadata.updatedAt, nostr, updateConfig]);

  if (!showStatus) return null;

  const allDone = relaySyncState === 'done' && feedsSyncState === 'idle' && dismissedSyncState === 'idle';
  const anySyncing = relaySyncState === 'syncing' || feedsSyncState === 'syncing' || dismissedSyncState === 'syncing';
  const anyError = relaySyncState === 'error' || feedsSyncState === 'error' || dismissedSyncState === 'error';

  return (
    <View style={styles.container}>
      <Text style={[
        styles.dot,
        anySyncing && styles.dotSyncing,
        allDone && styles.dotDone,
        anyError && styles.dotError,
      ]}>{'\u25CF'}</Text>
      <Text style={styles.label}>
        {anySyncing ? 'Syncing...' : anyError ? 'Sync error' : allDone ? 'Synced' : 'Nostr Sync'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  dot: {
    fontSize: 8,
    color: '#666',
  },
  dotSyncing: {
    color: '#f59e0b',
  },
  dotDone: {
    color: '#22c55e',
  },
  dotError: {
    color: '#ef4444',
  },
  label: {
    fontSize: 12,
    color: '#b3b3b3',
  },
});
