/**
 * AdvancedSettings — less-frequently-used settings with confirmation dialogs.
 *
 * Mirrors packages/web/src/components/AdvancedSettings.tsx.
 * Options: relay management, blossom server config, clear dismissed notes,
 * client tag toggle, public bookmarks toggle, profile cache, delete account.
 */
import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  ScrollView,
  Switch,
} from 'react-native';
import { getBlossomServers, setBlossomServers, DEFAULT_BLOSSOM_SERVERS } from '../hooks/useNostrBackup';

interface AdvancedSettingsProps {
  dismissedCount: number;
  onClearDismissed: () => void;
  onOpenProfileCache: () => void;
  publishClientTag: boolean;
  onToggleClientTag: () => void;
  publicBookmarks: boolean;
  onTogglePublicBookmarks: () => void;
  onDeleteAccount: () => void;
  // Relay management (optional — passed from SettingsScreen when available)
  relays?: { url: string; read: boolean; write: boolean }[];
  onAddRelay?: (url: string) => void;
  onRemoveRelay?: (url: string) => void;
  onToggleRelayRead?: (url: string) => void;
  onToggleRelayWrite?: (url: string) => void;
}

export function AdvancedSettings({
  dismissedCount,
  onClearDismissed,
  onOpenProfileCache,
  publishClientTag,
  onToggleClientTag,
  publicBookmarks,
  onTogglePublicBookmarks,
  onDeleteAccount,
  relays,
  onAddRelay,
  onRemoveRelay,
  onToggleRelayRead,
  onToggleRelayWrite,
}: AdvancedSettingsProps) {
  const [section, setSection] = useState<'main' | 'relays' | 'blossom'>('main');

  const handleClearDismissed = () => {
    if (dismissedCount === 0) {
      Alert.alert('No dismissed notes', 'There are no dismissed notes to restore.');
      return;
    }
    Alert.alert(
      'Bring back dismissed notes?',
      `This will restore ${dismissedCount} dismissed note${dismissedCount === 1 ? '' : 's'} to your feed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore notes', onPress: onClearDismissed },
      ],
    );
  };

  const handleProfileCache = () => {
    Alert.alert(
      'Open Profile Cache?',
      'View and manage locally cached profile data.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open', onPress: onOpenProfileCache },
      ],
    );
  };

  const handleClientTag = () => {
    Alert.alert(
      publishClientTag ? 'Disable client tag?' : 'Enable client tag?',
      publishClientTag
        ? 'Your posts will no longer include a tag identifying Corkboards as the client.'
        : 'Your posts will include a tag identifying Corkboards as the client.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: publishClientTag ? 'Disable' : 'Enable', onPress: onToggleClientTag },
      ],
    );
  };

  const handleBookmarks = () => {
    Alert.alert(
      publicBookmarks ? 'Make bookmarks private?' : 'Make bookmarks public?',
      publicBookmarks
        ? 'Your saved notes will be encrypted so only you can see them.'
        : 'Your saved notes will be visible to anyone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: publicBookmarks ? 'Make private' : 'Make public', onPress: onTogglePublicBookmarks },
      ],
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete your account?',
      'This will broadcast a deletion event to all relays. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: onDeleteAccount },
      ],
    );
  };

  if (section === 'relays' && relays) {
    return (
      <RelaySection
        relays={relays}
        onBack={() => setSection('main')}
        onAddRelay={onAddRelay}
        onRemoveRelay={onRemoveRelay}
        onToggleRelayRead={onToggleRelayRead}
        onToggleRelayWrite={onToggleRelayWrite}
      />
    );
  }

  if (section === 'blossom') {
    return <BlossomSection onBack={() => setSection('main')} />;
  }

  return (
    <View style={styles.container}>
      {/* Relay management */}
      {relays && (
        <TouchableOpacity style={styles.settingRow} onPress={() => setSection('relays')}>
          <Text style={styles.settingTitle}>Relays</Text>
          <Text style={styles.settingHint}>Manage relays, publish relay list ({relays.length} configured)</Text>
        </TouchableOpacity>
      )}

      {/* Blossom servers */}
      <TouchableOpacity style={styles.settingRow} onPress={() => setSection('blossom')}>
        <Text style={styles.settingTitle}>Blossom Servers</Text>
        <Text style={styles.settingHint}>Configure backup storage servers</Text>
      </TouchableOpacity>

      <View style={styles.separator} />

      {/* Dismissed notes */}
      {dismissedCount > 0 && (
        <TouchableOpacity style={styles.settingRow} onPress={handleClearDismissed}>
          <Text style={styles.settingTitle}>Bring back dismissed ({dismissedCount})</Text>
          <Text style={styles.settingHint}>Restore dismissed notes back into your feed</Text>
        </TouchableOpacity>
      )}

      {/* Profile cache */}
      <TouchableOpacity style={styles.settingRow} onPress={handleProfileCache}>
        <Text style={styles.settingTitle}>Profile Cache</Text>
        <Text style={styles.settingHint}>Manage locally cached Nostr profile data</Text>
      </TouchableOpacity>

      {/* Client tag */}
      <TouchableOpacity style={styles.settingRow} onPress={handleClientTag}>
        <Text style={styles.settingTitle}>
          {publishClientTag ? '\u2713 ' : ''}Client Tag
        </Text>
        <Text style={styles.settingHint}>Tag your posts as sent from Corkboards</Text>
      </TouchableOpacity>

      {/* Public bookmarks */}
      <TouchableOpacity style={styles.settingRow} onPress={handleBookmarks}>
        <Text style={styles.settingTitle}>
          {publicBookmarks ? '\u2713 ' : ''}Public Bookmarks
        </Text>
        <Text style={styles.settingHint}>
          {publicBookmarks
            ? 'Your saved notes are visible to others'
            : 'Your saved notes are encrypted and private'}
        </Text>
      </TouchableOpacity>

      {/* Separator */}
      <View style={styles.separator} />

      {/* Delete account */}
      <TouchableOpacity style={styles.dangerRow} onPress={handleDeleteAccount}>
        <Text style={styles.dangerTitle}>Delete Account</Text>
        <Text style={styles.dangerHint}>Broadcast a deletion event to all relays</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Relay Management Section ─────────────────────────────────────────────

function RelaySection({
  relays,
  onBack,
  onAddRelay,
  onRemoveRelay,
  onToggleRelayRead,
  onToggleRelayWrite,
}: {
  relays: { url: string; read: boolean; write: boolean }[];
  onBack: () => void;
  onAddRelay?: (url: string) => void;
  onRemoveRelay?: (url: string) => void;
  onToggleRelayRead?: (url: string) => void;
  onToggleRelayWrite?: (url: string) => void;
}) {
  const [newUrl, setNewUrl] = useState('');

  const getHostname = (url: string) => {
    try { return new URL(url).hostname; } catch { return url; }
  };

  const handleAdd = () => {
    let url = newUrl.trim();
    if (!url) return;
    if (!url.startsWith('wss://') && !url.startsWith('ws://')) url = 'wss://' + url;
    try { new URL(url); } catch {
      Alert.alert('Invalid URL');
      return;
    }
    onAddRelay?.(url);
    setNewUrl('');
  };

  return (
    <ScrollView style={styles.container}>
      <TouchableOpacity style={styles.backButton} onPress={onBack}>
        <Text style={styles.backText}>&larr; Back</Text>
      </TouchableOpacity>
      <Text style={styles.sectionTitle}>Relays ({relays.length})</Text>

      {relays.map(relay => (
        <View key={relay.url} style={styles.relayRow}>
          <Text style={styles.relayUrl} numberOfLines={1}>{getHostname(relay.url)}</Text>
          <View style={styles.relayToggles}>
            <View style={styles.toggleGroup}>
              <Text style={styles.toggleLabel}>R</Text>
              <Switch
                value={relay.read}
                onValueChange={() => onToggleRelayRead?.(relay.url)}
                trackColor={{ true: '#a855f7', false: '#555' }}
                style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
              />
            </View>
            <View style={styles.toggleGroup}>
              <Text style={styles.toggleLabel}>W</Text>
              <Switch
                value={relay.write}
                onValueChange={() => onToggleRelayWrite?.(relay.url)}
                trackColor={{ true: '#f97316', false: '#555' }}
                style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
              />
            </View>
            <TouchableOpacity
              onPress={() => {
                if (relays.length <= 1) return;
                Alert.alert('Remove relay?', relay.url, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: () => onRemoveRelay?.(relay.url) },
                ]);
              }}
              disabled={relays.length <= 1}
            >
              <Text style={[styles.removeText, relays.length <= 1 && { opacity: 0.3 }]}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="wss://relay.example.com"
          placeholderTextColor="#666"
          value={newUrl}
          onChangeText={setNewUrl}
          onSubmitEditing={handleAdd}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.addButton} onPress={handleAdd}>
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Blossom Server Management Section ────────────────────────────────────

function BlossomSection({ onBack }: { onBack: () => void }) {
  const [servers, setServersState] = useState<string[]>(getBlossomServers);
  const [newUrl, setNewUrl] = useState('');
  const [testResults, setTestResults] = useState<Map<string, 'ok' | 'error'>>(new Map());

  const getHostname = (url: string) => {
    try { return new URL(url).hostname; } catch { return url; }
  };

  const handleAdd = () => {
    let url = newUrl.trim();
    if (!url) return;
    if (!url.startsWith('https://')) url = 'https://' + url;
    if (!url.endsWith('/')) url += '/';
    try { new URL(url); } catch {
      Alert.alert('Invalid URL');
      return;
    }
    if (servers.includes(url)) {
      Alert.alert('Already in list');
      return;
    }
    const updated = [...servers, url];
    setServersState(updated);
    setBlossomServers(updated);
    setNewUrl('');
  };

  const handleRemove = (url: string) => {
    const updated = servers.filter(s => s !== url);
    setServersState(updated);
    setBlossomServers(updated);
  };

  const handleResetDefaults = () => {
    setServersState([...DEFAULT_BLOSSOM_SERVERS]);
    setBlossomServers([...DEFAULT_BLOSSOM_SERVERS]);
  };

  const testServer = useCallback(async (url: string) => {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000), method: 'HEAD' });
      setTestResults(prev => new Map(prev).set(url, resp.ok || resp.status === 405 ? 'ok' : 'error'));
    } catch {
      setTestResults(prev => new Map(prev).set(url, 'error'));
    }
  }, []);

  return (
    <ScrollView style={styles.container}>
      <TouchableOpacity style={styles.backButton} onPress={onBack}>
        <Text style={styles.backText}>&larr; Back</Text>
      </TouchableOpacity>
      <Text style={styles.sectionTitle}>Blossom Servers</Text>
      <Text style={styles.settingHint}>Blossom servers store encrypted backup files. Servers are tried in order.</Text>

      {servers.map((url, i) => {
        const result = testResults.get(url);
        const isDefault = DEFAULT_BLOSSOM_SERVERS.includes(url);
        return (
          <View key={url} style={styles.relayRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.relayUrl} numberOfLines={1}>
                {result === 'ok' ? '● ' : result === 'error' ? '○ ' : ''}
                {getHostname(url)}
                {isDefault ? ' (default)' : ''}
              </Text>
              <Text style={styles.settingHint}>#{i + 1}</Text>
            </View>
            <TouchableOpacity onPress={() => testServer(url)} style={{ marginRight: 8 }}>
              <Text style={styles.backText}>Test</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (servers.length <= 1) return;
                handleRemove(url);
              }}
              disabled={servers.length <= 1}
            >
              <Text style={[styles.removeText, servers.length <= 1 && { opacity: 0.3 }]}>✕</Text>
            </TouchableOpacity>
          </View>
        );
      })}

      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="https://blossom.example.com"
          placeholderTextColor="#666"
          value={newUrl}
          onChangeText={setNewUrl}
          onSubmitEditing={handleAdd}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.addButton} onPress={handleAdd}>
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.settingRow, { marginTop: 12 }]} onPress={handleResetDefaults}>
        <Text style={styles.backText}>Reset to defaults</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { gap: 2 },

  settingRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  settingTitle: {
    color: '#f2f2f2',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  settingHint: {
    color: '#888',
    fontSize: 12,
    paddingLeft: 0,
  },

  separator: {
    height: 1,
    backgroundColor: '#404040',
    marginVertical: 8,
  },

  dangerRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  dangerTitle: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  dangerHint: {
    color: '#f87171',
    fontSize: 12,
    opacity: 0.7,
  },

  sectionTitle: {
    color: '#f2f2f2',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    paddingHorizontal: 12,
  },

  backButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  backText: {
    color: '#a855f7',
    fontSize: 14,
  },

  relayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    marginBottom: 4,
  },
  relayUrl: {
    color: '#d4d4d4',
    fontSize: 13,
    fontFamily: 'monospace',
    flex: 1,
  },
  relayToggles: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toggleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  toggleLabel: {
    color: '#888',
    fontSize: 10,
    fontWeight: '600',
  },
  removeText: {
    color: '#888',
    fontSize: 16,
    paddingHorizontal: 6,
  },

  addRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    marginTop: 12,
  },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f2f2f2',
    fontSize: 13,
  },
  addButton: {
    backgroundColor: '#a855f7',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  addButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
