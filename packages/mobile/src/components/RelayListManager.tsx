/**
 * RelayListManager — manage Nostr relays with read/write toggles.
 *
 * Mirrors packages/web/src/components/RelayListManager.tsx.
 * Shows configured relays, allows add/remove, toggles read/write per relay,
 * and publishes kind 10002 (NIP-65) relay list events.
 */
import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Switch,
} from 'react-native';
import { useAuth } from '../lib/AuthContext';
import { useNostrPublish } from '../hooks/useNostrPublish';
import {
  FALLBACK_RELAYS,
  updateRelayCache,
  APP_CONFIG_KEY,
} from '../lib/NostrProvider';
import { mobileStorage } from '../storage/MmkvStorage';

interface RelayEntry {
  url: string;
  read: boolean;
  write: boolean;
}

function getRelayList(): RelayEntry[] {
  try {
    const stored = mobileStorage.getSync(APP_CONFIG_KEY);
    if (stored) {
      const config = JSON.parse(stored) as Record<string, unknown>;
      const relayMeta = config?.relayMetadata as Record<string, unknown> | undefined;
      const relays = Array.isArray(relayMeta?.relays) ? relayMeta.relays as unknown[] : [];
      return relays.filter(
        r => typeof r === 'object' && r !== null && typeof (r as { url?: unknown }).url === 'string',
      ) as RelayEntry[];
    }
  } catch { /* ignore */ }
  return [];
}

function saveRelayListToStorage(relays: RelayEntry[]): void {
  try {
    const stored = mobileStorage.getSync(APP_CONFIG_KEY);
    const config = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    config.relayMetadata = { relays, updatedAt: Math.floor(Date.now() / 1000) };
    mobileStorage.setSync(APP_CONFIG_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

function normalizeRelayUrl(url: string): string {
  url = url.trim();
  if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
    url = 'wss://' + url;
  }
  // Ensure trailing slash for consistency
  try { return new URL(url).toString(); } catch { return url; }
}

function renderRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'wss:') {
      return parsed.pathname === '/' ? parsed.host : parsed.host + parsed.pathname;
    }
    return parsed.href;
  } catch { return url; }
}

export function RelayListManager() {
  const { pubkey, signer } = useAuth();
  const { mutateAsync: publish } = useNostrPublish();

  const [relays, setRelays] = useState<RelayEntry[]>(() => getRelayList());
  const [newRelayUrl, setNewRelayUrl] = useState('');
  const [expandedRelay, setExpandedRelay] = useState<string | null>(null);

  // Sync from storage on mount
  useEffect(() => {
    setRelays(getRelayList());
  }, []);

  const publishNIP65 = async (relayList: RelayEntry[]) => {
    if (!signer) return;

    const tags = relayList
      .map(relay => {
        if (relay.read && relay.write) return ['r', relay.url];
        if (relay.read) return ['r', relay.url, 'read'];
        if (relay.write) return ['r', relay.url, 'write'];
        return null;
      })
      .filter((tag): tag is string[] => tag !== null);

    try {
      await publish({
        kind: 10002,
        content: '',
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      if (__DEV__) console.warn('[RelayListManager] Failed to publish relay list:', err);
    }
  };

  const saveAndPublish = (newRelays: RelayEntry[]) => {
    setRelays(newRelays);
    saveRelayListToStorage(newRelays);
    publishNIP65(newRelays);
  };

  const handleAddRelay = () => {
    const trimmed = newRelayUrl.trim();
    if (!trimmed) return;

    const normalized = normalizeRelayUrl(trimmed);

    if (relays.some(r => r.url === normalized)) {
      Alert.alert('Already added', 'This relay is already in your list.');
      setNewRelayUrl('');
      return;
    }

    const updated = [...relays, { url: normalized, read: true, write: true }];
    saveAndPublish(updated);

    if (pubkey) updateRelayCache(pubkey, [normalized]);

    setNewRelayUrl('');
    Alert.alert('Relay added', renderRelayUrl(normalized));
  };

  const handleRemoveRelay = (url: string) => {
    if (relays.length <= 1) {
      Alert.alert('Cannot remove', 'You must have at least one relay.');
      return;
    }

    Alert.alert('Remove relay', renderRelayUrl(url), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          const updated = relays.filter(r => r.url !== url);
          saveAndPublish(updated);
          if (expandedRelay === url) setExpandedRelay(null);
        },
      },
    ]);
  };

  const handleToggleRead = (url: string) => {
    const updated = relays.map(r =>
      r.url === url ? { ...r, read: !r.read } : r,
    );
    saveAndPublish(updated);
  };

  const handleToggleWrite = (url: string) => {
    const updated = relays.map(r =>
      r.url === url ? { ...r, write: !r.write } : r,
    );
    saveAndPublish(updated);
  };

  return (
    <View style={styles.container}>
      {/* Relay list */}
      {relays.length === 0 && (
        <View style={styles.emptyState}>
          <Text style={styles.hintText}>Default relays (not yet configured):</Text>
          {FALLBACK_RELAYS.map(url => (
            <Text key={url} style={styles.fallbackRelay}>{url}</Text>
          ))}
        </View>
      )}

      {relays.map(relay => (
        <View key={relay.url} style={styles.relayCard}>
          <View style={styles.relayHeader}>
            <Text style={styles.relayUrl} numberOfLines={1}>
              {renderRelayUrl(relay.url)}
            </Text>

            {/* Settings toggle */}
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() =>
                setExpandedRelay(expandedRelay === relay.url ? null : relay.url)
              }
            >
              <Text style={styles.gearIcon}>
                {expandedRelay === relay.url ? '\u25B2' : '\u2699'}
              </Text>
            </TouchableOpacity>

            {/* Remove button */}
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => handleRemoveRelay(relay.url)}
              disabled={relays.length <= 1}
            >
              <Text
                style={[
                  styles.removeIcon,
                  relays.length <= 1 && styles.removeIconDisabled,
                ]}
              >
                {'\u2715'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Expanded read/write toggles */}
          {expandedRelay === relay.url && (
            <View style={styles.toggleSection}>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Read</Text>
                <Switch
                  value={relay.read}
                  onValueChange={() => handleToggleRead(relay.url)}
                  trackColor={{ false: '#404040', true: '#a855f7' }}
                  thumbColor={relay.read ? '#d8b4fe' : '#888'}
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Write</Text>
                <Switch
                  value={relay.write}
                  onValueChange={() => handleToggleWrite(relay.url)}
                  trackColor={{ false: '#404040', true: '#f97316' }}
                  thumbColor={relay.write ? '#fdba74' : '#888'}
                />
              </View>
            </View>
          )}
        </View>
      ))}

      {/* Add relay form */}
      <View style={styles.addRow}>
        <TextInput
          style={[styles.input, styles.addInput]}
          placeholder="wss://relay.example.com"
          placeholderTextColor="#666"
          value={newRelayUrl}
          onChangeText={setNewRelayUrl}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={handleAddRelay}
          returnKeyType="done"
        />
        <TouchableOpacity
          style={[styles.addButton, !newRelayUrl.trim() && styles.buttonDisabled]}
          onPress={handleAddRelay}
          disabled={!newRelayUrl.trim()}
        >
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>

      {!pubkey && (
        <Text style={styles.hintText}>
          Log in to sync your relay list with Nostr
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },

  // Empty state
  emptyState: { marginBottom: 8 },
  hintText: { color: '#b3b3b3', fontSize: 12, marginBottom: 8 },
  fallbackRelay: {
    color: '#b3b3b3',
    fontSize: 13,
    fontFamily: 'monospace',
    marginBottom: 4,
    paddingLeft: 4,
  },

  // Relay card
  relayCard: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
  },
  relayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  relayUrl: {
    flex: 1,
    color: '#d4d4d4',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  iconButton: { padding: 4 },
  gearIcon: { color: '#888', fontSize: 16 },
  removeIcon: { color: '#888', fontSize: 14 },
  removeIconDisabled: { opacity: 0.3 },

  // Toggles
  toggleSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#404040',
    gap: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggleLabel: { color: '#d4d4d4', fontSize: 14 },

  // Add relay
  addRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  input: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
    color: '#f2f2f2',
    fontSize: 14,
  },
  addInput: { flex: 1 },
  addButton: {
    backgroundColor: '#333',
    paddingHorizontal: 20,
    borderRadius: 8,
    justifyContent: 'center',
  },
  addButtonText: { color: '#f97316', fontSize: 14, fontWeight: '500' },
  buttonDisabled: { opacity: 0.5 },
});
