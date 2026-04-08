import { useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  Image,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNotifications, getZapAmountSats, type NotificationItem } from '../hooks/useNotifications';
import { useMuteList } from '../hooks/useMuteList';
import { useAuthor } from '../hooks/useAuthor';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';
import { SizeGuardedImage } from '../components/SizeGuardedImage';

const TYPE_LABELS: Record<NotificationItem['type'], string> = {
  reply: 'replied',
  mention: 'mentioned you',
  repost: 'reposted',
  reaction: 'reacted',
  zap: 'zapped',
};

const TYPE_ICONS: Record<NotificationItem['type'], string> = {
  reply: '💬',
  mention: '📢',
  repost: '↻',
  reaction: '♥',
  zap: '⚡',
};

const TYPE_COLORS: Record<NotificationItem['type'], string> = {
  reply: '#3b82f6',
  mention: '#a855f7',
  repost: '#22c55e',
  reaction: '#ec4899',
  zap: '#f59e0b',
};

function NotificationRow({ notification }: { notification: NotificationItem }) {
  const { event, type, senderPubkey } = notification;
  // For zaps, show the real sender (from zap request), not the LNURL server
  const displayPubkey = senderPubkey ?? event.pubkey;
  const { data } = useAuthor(displayPubkey);
  const displayName = data?.metadata?.display_name || data?.metadata?.name || genUserName(displayPubkey);
  const avatar = data?.metadata?.picture;

  // For reactions, show the reaction content
  const extra = type === 'reaction' && event.content && event.content !== '+' ? ` ${event.content}` : '';

  // For zaps, show the amount
  const zapAmount = type === 'zap' ? getZapAmountSats(event) : null;
  const zapLabel = zapAmount ? ` ${zapAmount.toLocaleString()} sats` : '';

  return (
    <View style={styles.row}>
      {avatar ? (
        <SizeGuardedImage uri={avatar} style={styles.avatar} type="avatar" />
      ) : (
        <View style={[styles.avatar, styles.avatarPlaceholder]}>
          <Text style={styles.avatarLetter}>{displayName[0]?.toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.rowContent}>
        <Text style={styles.rowText} numberOfLines={2}>
          <Text style={styles.name}>{displayName}</Text>
          {' '}<Text style={{ color: TYPE_COLORS[type] }}>{TYPE_ICONS[type]}</Text>{' '}{TYPE_LABELS[type]}{extra}{zapLabel}
        </Text>
        <Text style={styles.time}>{formatTimeAgo(event.created_at)}</Text>
      </View>
    </View>
  );
}

export function NotificationsScreen() {
  const { pubkey } = useAuth();
  const { notifications: rawNotifications, isLoading, refetch } = useNotifications();
  const { mutedPubkeys } = useMuteList();

  // Filter muted users from notifications (check both event pubkey and real sender for zaps)
  const notifications = useMemo(() => {
    if (!rawNotifications || mutedPubkeys.size === 0) return rawNotifications;
    return rawNotifications.filter(n => {
      if (mutedPubkeys.has(n.event.pubkey)) return false;
      if (n.senderPubkey && mutedPubkeys.has(n.senderPubkey)) return false;
      return true;
    });
  }, [rawNotifications, mutedPubkeys]);

  if (!pubkey) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Notifications</Text>
        <Text style={styles.emptyText}>Log in to see notifications</Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#b3b3b3" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Notifications</Text>
      </View>
      <FlatList
        data={notifications ?? []}
        keyExtractor={item => item.event.id}
        renderItem={({ item }) => <NotificationRow notification={item} />}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={refetch}
            tintColor="#b3b3b3"
          />
        }
        ListEmptyComponent={<Text style={styles.emptyText}>No notifications yet</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2' },
  list: { padding: 8 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: '#404040' },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarPlaceholder: { backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#b3b3b3', fontSize: 14, fontWeight: '600' },
  rowContent: { flex: 1 },
  rowText: { fontSize: 14, color: '#b3b3b3', lineHeight: 19 },
  name: { fontWeight: '600', color: '#f2f2f2' },
  time: { fontSize: 11, color: '#b3b3b3', marginTop: 3 },
  emptyText: { color: '#666', textAlign: 'center', marginTop: 60, fontSize: 15 },
});
