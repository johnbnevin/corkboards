/**
 * DMStatusInfo — DM connection status display showing sync status,
 * protocol info, and cache management.
 *
 * Port of packages/web/src/components/dm/DMStatusInfo.tsx for React Native.
 * Uses available useDMs data from the mobile hooks.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useConversations } from '../../hooks/useDMs';

interface DMStatusInfoProps {
  clearCacheAndRefetch?: () => Promise<void>;
}

export function DMStatusInfo({ clearCacheAndRefetch }: DMStatusInfoProps) {
  const [isClearing, setIsClearing] = useState(false);
  const { conversations, isLoading } = useConversations();

  const handleClearCache = async () => {
    if (!clearCacheAndRefetch) return;

    setIsClearing(true);
    try {
      await clearCacheAndRefetch();
      Alert.alert('Cache cleared', 'Refetching messages from relays...');
      setIsClearing(false);
    } catch (error) {
      console.error('Error clearing cache:', error);
      Alert.alert('Error', 'Failed to clear cache. Please try again.');
      setIsClearing(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Status */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Messaging Status</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <View style={[styles.badge, isLoading ? styles.badgeLoading : styles.badgeReady]}>
            <Text style={styles.badgeText}>{isLoading ? 'Loading...' : 'Ready'}</Text>
          </View>
        </View>
        <Text style={styles.description}>
          {isLoading
            ? 'Fetching messages from Nostr relays...'
            : 'All systems operational'}
        </Text>
      </View>

      {/* Subscriptions */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Protocol Support</Text>
        <View style={styles.row}>
          <Text style={styles.label}>NIP-4 (Legacy DMs)</Text>
          <View style={[styles.badge, styles.badgeReady]}>
            <Text style={styles.badgeText}>Supported</Text>
          </View>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>NIP-17 (Private DMs)</Text>
          <View style={[styles.badge, styles.badgeReady]}>
            <Text style={styles.badgeText}>Supported</Text>
          </View>
        </View>
      </View>

      {/* Cache Info */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cache Information</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Conversations</Text>
          <Text style={styles.value}>{conversations.length}</Text>
        </View>
      </View>

      {/* Actions */}
      {clearCacheAndRefetch && (
        <View style={styles.actionsCard}>
          <Text style={styles.cardTitle}>Cache Management</Text>
          <Text style={styles.description}>
            Clear all cached messages and refetch from relays. This will force a fresh sync.
          </Text>
          <TouchableOpacity
            onPress={handleClearCache}
            disabled={isClearing}
            style={[styles.clearBtn, isClearing && styles.clearBtnDisabled]}
          >
            {isClearing ? (
              <ActivityIndicator color="#f2f2f2" size="small" />
            ) : (
              <Text style={styles.clearBtnText}>Clear Cache & Refetch</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#404040',
    gap: 8,
  },
  actionsCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#404040',
    gap: 10,
    borderTopWidth: 2,
    borderTopColor: '#333',
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#f2f2f2' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: { fontSize: 13, color: '#b3b3b3' },
  value: { fontSize: 13, fontWeight: '500', color: '#f2f2f2' },
  description: { fontSize: 12, color: '#b3b3b3' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeReady: { backgroundColor: 'rgba(168, 85, 247, 0.2)' },
  badgeLoading: { backgroundColor: 'rgba(249, 115, 22, 0.2)' },
  badgeText: { fontSize: 11, fontWeight: '500', color: '#f2f2f2' },
  clearBtn: {
    backgroundColor: '#333',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#404040',
  },
  clearBtnDisabled: { opacity: 0.5 },
  clearBtnText: { color: '#f2f2f2', fontSize: 13, fontWeight: '500' },
});
