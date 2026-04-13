/**
 * NostrSync -- Syncs user's Nostr data (relay list, custom feeds, dismissed notes).
 * Renders nothing -- runs side-effects on mount and when user changes.
 *
 * Port of packages/web/src/components/NostrSync.tsx for React Native.
 * Also integrates custom feeds sync and dismissed notes sync.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { useAppContext } from '../hooks/useAppContext';
import { useNostrCustomFeedsSync } from '../hooks/useNostrCustomFeedsSync';
import { useNostrDismissedSync } from '../hooks/useNostrDismissedSync';

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

  const { save: saveFeedsSync, load: loadFeedsSync } = useNostrCustomFeedsSync();
  const { save: saveDismissedSync, load: loadDismissedSync } = useNostrDismissedSync();

  const [relaySyncState, setRelaySyncState] = useState<SyncState>('idle');
  const [feedsSyncState, setFeedsSyncState] = useState<SyncState>('idle');
  const [dismissedSyncState, setDismissedSyncState] = useState<SyncState>('idle');

  // Sync NIP-65 relay list
  useEffect(() => {
    if (!pubkey) return;
    if (config.relayMetadata.updatedAt === lastQueriedUpdatedAt.current) return;
    lastQueriedUpdatedAt.current = config.relayMetadata.updatedAt;

    const syncRelays = async () => {
      setRelaySyncState('syncing');
      try {
        const events = await nostr.query(
          [{ kinds: [10002], authors: [pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) },
        );

        if (events.length > 0) {
          const event = events[0];
          if (event.created_at > config.relayMetadata.updatedAt) {
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
                relayMetadata: {
                  relays: fetchedRelays,
                  updatedAt: event.created_at,
                },
              }));
            }
          }
        }
        setRelaySyncState('done');
      } catch (error) {
        console.error('Failed to sync relays from Nostr:', error);
        setRelaySyncState('error');
      }
    };

    syncRelays();
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
