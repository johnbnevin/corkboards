/**
 * Notifications screen -- displays Nostr notifications with filter toggles,
 * dismiss/collapse support, and explicit "Load more" pagination.
 *
 * Uses NotificationCard component for each notification.
 * Mirrors web's NotificationsCorkboard filter and dismiss patterns.
 */
import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNotifications, type NotificationType } from '../hooks/useNotifications';
import { useMuteList } from '../hooks/useMuteList';
import { useCollapsedNotes } from '../hooks/useCollapsedNotes';
import { NotificationCard } from '../components/NotificationCard';

// ---- Filter config ----

type NotifFilter = NotificationType;

const FILTER_DEFS: { kind: NotifFilter; icon: string; label: string; color: string }[] = [
  { kind: 'reply',    icon: '\u{1F4AC}', label: 'Replies',   color: '#3b82f6' },
  { kind: 'mention',  icon: '\u{1F4E2}', label: 'Mentions',  color: '#a855f7' },
  { kind: 'repost',   icon: '\u21BB',    label: 'Reposts',   color: '#22c55e' },
  { kind: 'reaction', icon: '\u2665',    label: 'Reactions', color: '#ec4899' },
  { kind: 'zap',      icon: '\u26A1',    label: 'Zaps',      color: '#f59e0b' },
];

// ---- Filter toggle bar ----

function FilterBar({
  counts,
  hiddenTypes,
  onToggle,
}: {
  counts: Record<NotifFilter, number>;
  hiddenTypes: Set<NotifFilter>;
  onToggle: (kind: NotifFilter) => void;
}) {
  return (
    <View style={filterStyles.bar}>
      {FILTER_DEFS.map(({ kind, icon, label, color }) => {
        const active = !hiddenTypes.has(kind);
        return (
          <TouchableOpacity
            key={kind}
            style={[filterStyles.chip, active && { borderColor: color }]}
            onPress={() => onToggle(kind)}
            activeOpacity={0.7}
          >
            <Text style={[filterStyles.chipIcon, { color: active ? color : '#666' }]}>{icon}</Text>
            <Text style={[filterStyles.chipCount, active ? { color: '#f2f2f2' } : { color: '#666' }]}>
              {counts[kind]}
            </Text>
            <Text style={[filterStyles.chipLabel, active ? { color: '#b3b3b3' } : { color: '#555' }]}>
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const filterStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#404040',
    backgroundColor: '#2a2a2a',
  },
  chipIcon: { fontSize: 12 },
  chipCount: { fontSize: 12, fontWeight: '600' },
  chipLabel: { fontSize: 11 },
});

// ---- Main component ----

export function NotificationsScreen() {
  const { pubkey } = useAuth();
  const { notifications: rawNotifications, isLoading, refetch, loadMore, hasMore } = useNotifications();
  const { mutedPubkeys } = useMuteList();
  const { isDismissed } = useCollapsedNotes();
  const [hiddenTypes, setHiddenTypes] = useState<Set<NotifFilter>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);

  const toggleFilter = useCallback((kind: NotifFilter) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  // Filter muted users
  const notifications = useMemo(() => {
    if (!rawNotifications) return [];
    return rawNotifications.filter(n => {
      if (mutedPubkeys.size > 0) {
        if (mutedPubkeys.has(n.event.pubkey)) return false;
        if (n.senderPubkey && mutedPubkeys.has(n.senderPubkey)) return false;
      }
      return true;
    });
  }, [rawNotifications, mutedPubkeys]);

  // Count by type (before type filtering)
  const counts = useMemo((): Record<NotifFilter, number> => {
    const c: Record<NotifFilter, number> = {
      reaction: 0, reply: 0, mention: 0, repost: 0, zap: 0,
    };
    for (const n of notifications) c[n.type]++;
    return c;
  }, [notifications]);

  // Apply type filters and dismissed status
  const filtered = useMemo(
    () => notifications.filter(n => !hiddenTypes.has(n.type) && !isDismissed(n.event.id)),
    [notifications, hiddenTypes, isDismissed],
  );

  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true);
    loadMore();
    // Small delay for UI feedback
    setTimeout(() => setLoadingMore(false), 500);
  }, [loadMore]);

  if (!pubkey) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Notifications</Text>
        <Text style={styles.emptyText}>Log in to see notifications</Text>
      </View>
    );
  }

  if (isLoading && notifications.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#b3b3b3" size="large" />
        <Text style={styles.loadingText}>Loading notifications...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Notifications</Text>
        {notifications.length > 0 && (
          <Text style={styles.subtitle}>{notifications.length} total</Text>
        )}
      </View>

      {/* Filter toggles */}
      {notifications.length > 0 && (
        <FilterBar counts={counts} hiddenTypes={hiddenTypes} onToggle={toggleFilter} />
      )}

      {/* Clear filters button */}
      {hiddenTypes.size > 0 && (
        <TouchableOpacity
          style={styles.clearFilters}
          onPress={() => setHiddenTypes(new Set())}
        >
          <Text style={styles.clearFiltersText}>Show all types</Text>
        </TouchableOpacity>
      )}

      {/* Empty filtered state */}
      {notifications.length > 0 && filtered.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            All notification types are hidden
          </Text>
          <TouchableOpacity
            style={styles.showAllBtn}
            onPress={() => setHiddenTypes(new Set())}
          >
            <Text style={styles.showAllText}>Show all</Text>
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={item => item.event.id}
        renderItem={({ item }) => (
          <NotificationCard notification={item} />
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={refetch}
            tintColor="#b3b3b3"
          />
        }
        ListEmptyComponent={
          notifications.length === 0 ? (
            <Text style={styles.emptyText}>No notifications yet</Text>
          ) : null
        }
        ListFooterComponent={
          hasMore ? (
            <TouchableOpacity
              style={styles.loadMoreBtn}
              onPress={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <ActivityIndicator color="#f97316" size="small" />
              ) : (
                <Text style={styles.loadMoreText}>Load more notifications</Text>
              )}
            </TouchableOpacity>
          ) : filtered.length > 0 ? (
            <Text style={styles.endText}>No more notifications</Text>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#404040',
  },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  subtitle: { fontSize: 12, color: '#b3b3b3', marginTop: 2 },
  loadingText: { color: '#b3b3b3', fontSize: 14 },
  list: { padding: 8, gap: 8 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60, fontSize: 15 },
  clearFilters: {
    alignSelf: 'flex-start',
    marginLeft: 16,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#333',
    borderRadius: 12,
  },
  clearFiltersText: { color: '#b3b3b3', fontSize: 11 },
  showAllBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    marginTop: 8,
  },
  showAllText: { color: '#f2f2f2', fontSize: 13 },
  loadMoreBtn: {
    alignItems: 'center',
    padding: 16,
    marginTop: 4,
  },
  loadMoreText: { color: '#f97316', fontSize: 14, fontWeight: '500' },
  endText: { color: '#555', fontSize: 12, textAlign: 'center', paddingVertical: 16 },
});
