/**
 * ProfileCacheSettings — Shows cached profile count, cache size,
 * and clear cache button. Mirrors web's ProfileCacheSettings.tsx
 * but uses MMKV storage instead of IndexedDB.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { mobileStorage } from '../storage/MmkvStorage';
import { clearProfileCache } from '../lib/cacheStore';

const PROFILE_PREFIX = 'profile-cache:';

interface CacheStats {
  totalProfiles: number;
  oldestCache: number | null;
  newestCache: number | null;
}

async function getProfileCacheStats(): Promise<CacheStats> {
  const allKeys = await mobileStorage.keys();
  const profileKeys = allKeys.filter(k => k.startsWith(PROFILE_PREFIX));

  let oldest: number | null = null;
  let newest: number | null = null;

  for (const key of profileKeys) {
    try {
      const stored = mobileStorage.getSync(key);
      if (!stored) continue;
      const profile = JSON.parse(stored);
      const cachedAt = profile.cachedAt;
      if (typeof cachedAt === 'number') {
        if (oldest === null || cachedAt < oldest) oldest = cachedAt;
        if (newest === null || cachedAt > newest) newest = cachedAt;
      }
    } catch {
      // skip malformed entries
    }
  }

  return {
    totalProfiles: profileKeys.length,
    oldestCache: oldest,
    newestCache: newest,
  };
}

function formatAge(timestamp: number | null): string {
  if (!timestamp) return 'Unknown';
  const age = Date.now() - timestamp;
  const days = Math.floor(age / (1000 * 60 * 60 * 24));
  const hours = Math.floor((age % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ago`;
  return 'Just now';
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const d = new Date(timestamp);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}

export function ProfileCacheSettings() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastCleared, setLastCleared] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const s = await getProfileCacheStats();
      setStats(s);
    } catch (error) {
      console.warn('Failed to load profile cache stats:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleClearCache = useCallback(() => {
    Alert.alert(
      'Clear Profile Cache?',
      'This will remove all cached profile data. Profiles will be re-fetched from the network when you next encounter them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Cache',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearProfileCache();
              setLastCleared(new Date().toLocaleString());
              await loadStats();
            } catch (error) {
              console.warn('Failed to clear profile cache:', error);
            }
          },
        },
      ],
    );
  }, [loadStats]);

  return (
    <View style={styles.container}>
      {/* Stats card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Profile Cache</Text>
          <Text style={styles.cardDescription}>
            Persistent profile cache stores user metadata across sessions.
          </Text>
        </View>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color="#b3b3b3" size="small" />
            <Text style={styles.loadingText}>Loading cache stats...</Text>
          </View>
        ) : stats ? (
          <View style={styles.statsGrid}>
            <View style={styles.statBlock}>
              <Text style={styles.statLabel}>Total Profiles</Text>
              <Text style={styles.statValue}>{stats.totalProfiles}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.statRow}>
              <View style={styles.statBlock}>
                <Text style={styles.statLabel}>Oldest Cache</Text>
                <Text style={styles.statDate}>{formatDate(stats.oldestCache)}</Text>
                <Text style={styles.statAge}>{formatAge(stats.oldestCache)}</Text>
              </View>
              <View style={styles.statBlock}>
                <Text style={styles.statLabel}>Newest Cache</Text>
                <Text style={styles.statDate}>{formatDate(stats.newestCache)}</Text>
                <Text style={styles.statAge}>{formatAge(stats.newestCache)}</Text>
              </View>
            </View>
          </View>
        ) : (
          <Text style={styles.emptyText}>No cache statistics available</Text>
        )}

        <TouchableOpacity
          style={styles.refreshButton}
          onPress={loadStats}
          disabled={isLoading}
        >
          <Text style={styles.refreshButtonText}>
            {isLoading ? 'Refreshing...' : 'Refresh Stats'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Management card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Cache Management</Text>
          <Text style={styles.cardDescription}>
            Profiles are automatically refreshed when accessed.
          </Text>
        </View>

        <TouchableOpacity style={styles.clearButton} onPress={handleClearCache}>
          <Text style={styles.clearButtonText}>Clear All Cached Profiles</Text>
        </TouchableOpacity>

        <Text style={styles.helpText}>
          This will remove all cached profile data. Profiles will be re-fetched on next access.
        </Text>

        {lastCleared && (
          <Text style={styles.clearedText}>Cache cleared: {lastCleared}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16 },

  card: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    padding: 16,
  },

  cardHeader: { marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#f2f2f2', marginBottom: 4 },
  cardDescription: { fontSize: 13, color: '#999', lineHeight: 18 },

  // Stats
  statsGrid: { gap: 12 },
  statBlock: { flex: 1 },
  statLabel: { fontSize: 12, fontWeight: '500', color: '#999', marginBottom: 4 },
  statValue: { fontSize: 28, fontWeight: 'bold', color: '#f2f2f2' },
  statDate: { fontSize: 12, color: '#b3b3b3' },
  statAge: { fontSize: 11, color: '#999', marginTop: 2 },
  statRow: { flexDirection: 'row', gap: 16 },

  divider: { height: 1, backgroundColor: '#404040', marginVertical: 4 },

  // Loading
  loadingContainer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  loadingText: { fontSize: 13, color: '#999' },

  emptyText: { fontSize: 13, color: '#666', textAlign: 'center', paddingVertical: 12 },

  // Buttons
  refreshButton: {
    backgroundColor: '#333',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#404040',
  },
  refreshButtonText: { fontSize: 13, color: '#b3b3b3', fontWeight: '500' },

  clearButton: {
    backgroundColor: '#7f1d1d',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  clearButtonText: { fontSize: 14, color: '#fecaca', fontWeight: '600' },

  helpText: { fontSize: 12, color: '#999', marginTop: 8, lineHeight: 18 },
  clearedText: { fontSize: 12, color: '#4ade80', marginTop: 8 },
});
