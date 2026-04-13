/**
 * WalletSettings — NWC (Nostr Wallet Connect) configuration UI.
 *
 * Mirrors packages/web/src/components/WalletSettings.tsx.
 * Paste a nostr+walletconnect:// URI to connect, view status, disconnect.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
} from 'react-native';
import { useNwc } from '../hooks/useNwc';

export function WalletSettings() {
  const { setNwcUri, isConnected, walletRelay, disconnect } = useNwc();
  const [inputUri, setInputUri] = useState('');
  const [error, setError] = useState('');

  const handleConnect = () => {
    const trimmed = inputUri.trim();
    if (!trimmed.startsWith('nostr+walletconnect://')) {
      setError('URI must start with nostr+walletconnect://');
      return;
    }
    try {
      setNwcUri(trimmed);
      setInputUri('');
      setError('');
      Alert.alert('Wallet connected', 'Lightning wallet connected successfully.');
    } catch {
      setError('Invalid NWC URI \u2014 check the format and try again');
    }
  };

  const handleDisconnect = () => {
    Alert.alert('Disconnect wallet', 'Are you sure you want to disconnect your Lightning wallet?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: disconnect },
    ]);
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Wallet Connection</Text>
        {isConnected && (
          <View style={styles.statusBadge}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>Connected</Text>
          </View>
        )}
      </View>

      <Text style={styles.description}>
        Connect a bitcoin Lightning wallet via Nostr Wallet Connect (NWC) to send zaps.
      </Text>

      {isConnected ? (
        <View style={styles.connectedSection}>
          {walletRelay && (
            <Text style={styles.relayInfo}>
              Relay: <Text style={styles.relayMono}>{walletRelay.replace('wss://', '')}</Text>
            </Text>
          )}
          <TouchableOpacity style={styles.disconnectButton} onPress={handleDisconnect}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.connectSection}>
          <TextInput
            style={styles.input}
            placeholder="nostr+walletconnect://..."
            placeholderTextColor="#666"
            value={inputUri}
            onChangeText={v => { setInputUri(v); setError(''); }}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            onSubmitEditing={handleConnect}
            returnKeyType="done"
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <TouchableOpacity
            style={[
              styles.connectButton,
              !inputUri.trim().startsWith('nostr+walletconnect://') && styles.buttonDisabled,
            ]}
            onPress={handleConnect}
            disabled={!inputUri.trim().startsWith('nostr+walletconnect://')}
          >
            <Text style={styles.connectButtonText}>Connect</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.helpText}>
        Need a wallet?{' '}
        <Text
          style={styles.helpLink}
          onPress={() => Linking.openURL('https://coinos.io')}
        >
          coinos.io
        </Text>
        {' \u2014 no signup required.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },

  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: '#f2f2f2',
    fontSize: 16,
    fontWeight: '600',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#a855f7',
  },
  statusText: {
    color: '#c084fc',
    fontSize: 12,
  },

  description: {
    color: '#b3b3b3',
    fontSize: 13,
  },

  // Connected state
  connectedSection: { gap: 12 },
  relayInfo: {
    color: '#888',
    fontSize: 12,
  },
  relayMono: {
    fontFamily: 'monospace',
  },
  disconnectButton: {
    backgroundColor: '#2a1a1a',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  disconnectText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '500',
  },

  // Connect state
  connectSection: { gap: 12 },
  input: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
    color: '#f2f2f2',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
  },
  connectButton: {
    backgroundColor: '#f97316',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  connectButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: { opacity: 0.5 },

  // Help
  helpText: {
    color: '#888',
    fontSize: 12,
  },
  helpLink: {
    color: '#a855f7',
  },
});
