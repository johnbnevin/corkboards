/**
 * Saved for Later screen — displays user's bookmarked notes (NIP-51 kind 10003).
 *
 * Mirrors web's SavedForLaterCorkboard with:
 * - Failed note retry support
 * - Batch relay fetching for bookmarked notes
 * - ZapDialog for zap actions
 * - NoteCard component for rendering
 * - Pin/unpin support
 */
import { useCallback, useMemo, useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/AuthContext';
import { useNostr, FALLBACK_RELAYS, getUserRelays } from '../lib/NostrProvider';
import { useBookmarks } from '../hooks/useBookmarks';
import { usePinnedNotes } from '../hooks/usePinnedNotes';
import { useCollapsedNotes } from '../hooks/useCollapsedNotes';
import { useToast } from '../hooks/useToast';
import { NoteCard } from '../components/NoteCard';
import { ZapDialog } from '../components/ZapDialog';

export function SavedScreen() {
  const { pubkey } = useAuth();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { bookmarkIds, toggleBookmark, isBookmarked, isLoading: bookmarksLoading } = useBookmarks();
  const { pinnedIds, togglePin } = usePinnedNotes();
  const { collapsedIds, expand } = useCollapsedNotes();
  const { toast } = useToast();

  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);

  // Merge collapsed IDs with bookmark IDs (union) for backward compat
  const savedIds = useMemo(() => {
    return [...new Set([...collapsedIds, ...bookmarkIds])];
  }, [collapsedIds, bookmarkIds]);

  // Fetch the actual events for saved IDs using batch relay fetching
  const { data: events, isLoading: eventsLoading, refetch } = useQuery<NostrEvent[]>({
    queryKey: ['saved-notes', savedIds.join(',')],
    queryFn: async ({ signal }) => {
      if (savedIds.length === 0) return [];

      // Query write relays + read relays + fallbacks directly
      const userRelays = getUserRelays();
      const relaysToQuery = [...new Set([...userRelays.write, ...userRelays.read, ...FALLBACK_RELAYS])];

      const batchSize = 50;
      const allEvents: NostrEvent[] = [];
      const foundIds = new Set<string>();

      for (let i = 0; i < savedIds.length; i += batchSize) {
        const batch = savedIds.slice(i, i + batchSize);
        // Query all relays in parallel, dedupe results
        const results = await Promise.allSettled(
          relaysToQuery.map(url => {
            try {
              const relay = nostr.relay(url);
              return relay.query(
                [{ ids: batch }],
                { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
              );
            } catch {
              return Promise.resolve([] as NostrEvent[]);
            }
          }),
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            for (const event of result.value) {
              if (!foundIds.has(event.id)) {
                foundIds.add(event.id);
                allEvents.push(event);
              }
            }
          }
        }
      }

      // Track failed IDs
      const missing = savedIds.filter(id => !foundIds.has(id));
      setFailedIds(missing);

      return allEvents.sort((a, b) => b.created_at - a.created_at);
    },
    enabled: savedIds.length > 0,
    staleTime: 2 * 60_000,
  });

  // Sort: pinned first, then by time
  const sortedEvents = useMemo(() => {
    if (!events) return [];
    return [...events].sort((a, b) => {
      const aPinned = pinnedIds.includes(a.id);
      const bPinned = pinnedIds.includes(b.id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return b.created_at - a.created_at;
    });
  }, [events, pinnedIds]);

  const handleRetryFailed = useCallback(async () => {
    setRetrying(true);
    await refetch();
    setRetrying(false);
  }, [refetch]);

  const handleRemoveFailed = useCallback(() => {
    const count = failedIds.length;
    failedIds.forEach(id => {
      expand(id); // remove from collapsed
      if (isBookmarked(id)) toggleBookmark(id); // remove from bookmarks
    });
    toast({
      title: `Removed ${count} unavailable notes`,
      description: 'These notes could not be found on your relays.',
    });
    setFailedIds([]);
  }, [failedIds, expand, isBookmarked, toggleBookmark, toast]);

  const renderNote = useCallback(
    ({ item }: { item: NostrEvent }) => (
      <View style={styles.cardWrapper}>
        {pinnedIds.includes(item.id) && (
          <Text style={styles.pinnedBadge}>Pinned</Text>
        )}
        <NoteCard
          event={item}
          isBookmarked={isBookmarked(item.id)}
          onToggleBookmark={() => toggleBookmark(item.id)}
        />
        <View style={styles.savedActions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => togglePin(item.id)}>
            <Text style={styles.actionText}>
              {pinnedIds.includes(item.id) ? 'Unpin' : 'Pin'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setZapTarget(item)}>
            <Text style={styles.zapText}>Zap</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => {
              toggleBookmark(item.id);
              expand(item.id);
            }}
          >
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [pinnedIds, isBookmarked, toggleBookmark, togglePin, expand],
  );

  if (!pubkey) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Log in to save notes for later</Text>
      </View>
    );
  }

  const isLoading = bookmarksLoading || eventsLoading;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Saved</Text>
        <Text style={styles.subtitle}>
          {savedIds.length} saved note{savedIds.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Failed notes banner */}
      {failedIds.length > 0 && (
        <View style={styles.failedBanner}>
          <Text style={styles.failedText}>
            {failedIds.length} note{failedIds.length !== 1 ? 's' : ''} could not be found on your relays.
          </Text>
          <View style={styles.failedActions}>
            <TouchableOpacity style={styles.retryBtn} onPress={handleRetryFailed} disabled={retrying}>
              {retrying ? (
                <ActivityIndicator color="#f59e0b" size="small" />
              ) : (
                <Text style={styles.retryText}>Retry</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.removeFailedBtn} onPress={handleRemoveFailed}>
              <Text style={styles.removeFailedText}>Remove unavailable</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {isLoading && sortedEvents.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color="#b3b3b3" size="large" />
          <Text style={styles.loadingText}>Loading saved notes...</Text>
        </View>
      ) : sortedEvents.length === 0 && savedIds.length > 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            None of your {savedIds.length} saved notes could be found on your current relays.
          </Text>
          <TouchableOpacity style={styles.retryLargeBtn} onPress={handleRetryFailed}>
            <Text style={styles.retryLargeText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={sortedEvents}
          keyExtractor={item => item.id}
          renderItem={renderNote}
          contentContainerStyle={styles.list}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refetch}
              tintColor="#b3b3b3"
            />
          }
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No saved notes yet. Tap the bookmark icon on any note to save it.
            </Text>
          }
        />
      )}

      {/* Zap dialog */}
      <ZapDialog
        note={zapTarget}
        visible={!!zapTarget}
        onClose={() => setZapTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 16 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  subtitle: { fontSize: 12, color: '#b3b3b3', marginTop: 2 },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  list: { padding: 12, gap: 8 },

  // Card wrapper with saved-specific actions
  cardWrapper: {
    gap: 0,
  },
  pinnedBadge: { fontSize: 11, color: '#f97316', fontWeight: '600', paddingHorizontal: 14, paddingBottom: 4 },
  savedActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#2a2a2a',
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: '#404040',
  },
  actionBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  actionText: { color: '#f97316', fontSize: 13, fontWeight: '500' },
  zapText: { color: '#f59e0b', fontSize: 13, fontWeight: '500' },
  removeText: { color: '#ef4444', fontSize: 13, fontWeight: '500' },

  // Failed notes banner
  failedBanner: {
    backgroundColor: '#2a1f0e',
    borderBottomWidth: 1,
    borderBottomColor: '#4a3520',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  failedText: { color: '#f59e0b', fontSize: 13, marginBottom: 6 },
  failedActions: { flexDirection: 'row', gap: 12 },
  retryBtn: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: '#4a3520' },
  retryText: { color: '#f59e0b', fontSize: 12, fontWeight: '500' },
  removeFailedBtn: { paddingVertical: 4, paddingHorizontal: 10 },
  removeFailedText: { color: '#b3b3b3', fontSize: 12 },

  // Retry large button
  retryLargeBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
  },
  retryLargeText: { color: '#f2f2f2', fontSize: 14, fontWeight: '500' },

  emptyText: { color: '#666', textAlign: 'center', marginTop: 60, paddingHorizontal: 24, lineHeight: 20 },
});
