/**
 * Login modal — nsec direct login for existing accounts.
 * Mobile port of web's LoginDialog (nsec login portion).
 * Uses AuthContext.loginWithNsec for keychain-backed auth.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useAuth } from '../../lib/AuthContext';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
}

export function LoginDialog({ isOpen, onClose, onLogin }: LoginDialogProps) {
  const { loginWithNsec } = useAuth();
  const [nsec, setNsec] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    const trimmed = nsec.trim();
    if (!trimmed) {
      setError('Please enter your nsec key');
      return;
    }
    if (!trimmed.startsWith('nsec1')) {
      setError('Invalid key — must start with nsec1');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await loginWithNsec(trimmed);
      // Clear state before callbacks
      setNsec('');
      setError(null);
      onLogin();
      onClose();
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : String(e)) || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setNsec('');
    setError(null);
    setLoading(false);
    onClose();
  };

  return (
    <Modal visible={isOpen} transparent animationType="fade" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity style={styles.backdropTouch} activeOpacity={1} onPress={handleClose}>
          <View style={styles.dialog} onStartShouldSetResponder={() => true}>
            <Text style={styles.title}>Log in with nsec</Text>
            <Text style={styles.subtitle}>
              Enter your secret key (nsec) to log in to your existing Nostr account.
            </Text>

            {/* Warning box */}
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                <Text style={styles.warningBold}>Stored securely: </Text>
                Your key is saved in the OS keychain (Keychain on iOS, Keystore on Android),
                encrypted and hardware-backed.
              </Text>
            </View>

            <Text style={styles.label}>Secret key (nsec)</Text>
            <TextInput
              style={styles.input}
              value={nsec}
              onChangeText={(text) => { setNsec(text); setError(null); }}
              placeholder="nsec1..."
              placeholderTextColor="#666"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.disabledBtn]}
                onPress={handleLogin}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.primaryText}>Log in</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  backdropTouch: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  dialog: {
    backgroundColor: '#1f1f1f',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 360,
    gap: 12,
  },
  title: {
    color: '#f2f2f2',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: '#b3b3b3',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  warningBox: {
    backgroundColor: '#1a2a1a',
    borderWidth: 1,
    borderColor: '#2a4a2a',
    borderRadius: 8,
    padding: 12,
  },
  warningText: {
    color: '#4ade80',
    fontSize: 12,
    lineHeight: 17,
  },
  warningBold: {
    fontWeight: '600',
  },
  label: {
    color: '#999',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 14,
    color: '#f2f2f2',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  error: {
    color: '#ef4444',
    fontSize: 13,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  cancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  cancelText: {
    color: '#b3b3b3',
    fontSize: 15,
  },
  primaryBtn: {
    backgroundColor: '#f97316',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 100,
  },
  disabledBtn: {
    opacity: 0.5,
  },
  primaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
