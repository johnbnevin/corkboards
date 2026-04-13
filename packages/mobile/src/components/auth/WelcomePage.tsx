/**
 * Welcome / landing page for unauthenticated users.
 * Mobile port of web's WelcomePage component.
 * Shows app branding, create account (name + key backup), and login options (nsec).
 * Uses AuthContext.loginWithNsec for keychain-backed auth.
 */
import { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { useAuth } from '../../lib/AuthContext';
import { useNostr } from '../../lib/NostrProvider';
import { SecurityInfoDialog } from './SecurityInfoDialog';
import { SignerRecommendations, getTopSignerForPlatform } from './SignerRecommendations';

type Step = 'welcome' | 'key-backup';
type LoginView = 'main' | 'nsec';

interface WelcomePageProps {
  onComplete?: () => void;
}

export function WelcomePage({ onComplete }: WelcomePageProps) {
  const { loginWithNsec } = useAuth();
  const { nostr } = useNostr();

  const [step, setStep] = useState<Step>('welcome');
  const [loginView, setLoginView] = useState<LoginView>('main');
  const [name, setName] = useState('');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Nsec login state
  const [loginNsec, setLoginNsec] = useState('');
  const [nsecLoginLoading, setNsecLoginLoading] = useState(false);
  const [nsecLoginError, setNsecLoginError] = useState<string | null>(null);

  // Clear nsec from state on unmount
  useEffect(() => {
    return () => { setNsec(''); setLoginNsec(''); };
  }, []);

  const handleStart = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name required', 'Please enter a name to get started.');
      return;
    }
    const sk = generateSecretKey();
    const generatedNsec = nip19.nsecEncode(sk);
    setNsec(generatedNsec);
    setStep('key-backup');
  };

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
      // Auto-clear clipboard after 30s for security
      setTimeout(() => {
        Clipboard.setStringAsync('').catch(() => {});
      }, 30000);
    } catch {
      Alert.alert('Copy failed', 'Could not copy to clipboard.');
    }
  };

  const handleSaved = async () => {
    setIsLoading(true);
    try {
      await loginWithNsec(nsec);

      // Publish kind 0 (profile metadata)
      try {
        const decoded = nip19.decode(nsec);
        if (decoded.type === 'nsec') {
          const { NSecSigner } = await import('@nostrify/nostrify');
          const signer = new NSecSigner(decoded.data);
          const template = {
            kind: 0,
            content: JSON.stringify({ name: name.trim(), display_name: name.trim() }),
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          };
          const signed = await signer.signEvent(template);
          await nostr.event(signed);
        }
      } catch {
        // Profile publish is optional — don't alarm new users
      }

      onComplete?.();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNsecLogin = async () => {
    const trimmed = loginNsec.trim();
    if (!trimmed) {
      setNsecLoginError('Please enter your nsec key');
      return;
    }
    if (!trimmed.startsWith('nsec1')) {
      setNsecLoginError('Invalid key — must start with nsec1');
      return;
    }
    setNsecLoginLoading(true);
    setNsecLoginError(null);
    try {
      await loginWithNsec(trimmed);
      setLoginNsec('');
      onComplete?.();
    } catch (e: unknown) {
      setNsecLoginError((e instanceof Error ? e.message : String(e)) || 'Login failed');
    } finally {
      setNsecLoginLoading(false);
    }
  };

  // ---- Key Backup Step ----
  if (step === 'key-backup') {
    const topSigner = getTopSignerForPlatform();

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Save your password</Text>
        <Text style={styles.subtitle}>
          This is your password. Save it in a signer app ({topSigner.name} recommended)
          or where you save your other passwords.
        </Text>

        {/* Key display */}
        <Text style={styles.label}>Your secret key</Text>
        <View style={styles.keyBox}>
          <Text style={styles.nsec} selectable={showKey} numberOfLines={showKey ? 3 : 1}>
            {showKey ? nsec : '\u2022'.repeat(40)}
          </Text>
          <TouchableOpacity onPress={() => setShowKey(!showKey)} style={styles.eyeBtn}>
            <Text style={styles.eyeText}>{showKey ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.copyBtn} onPress={handleCopy}>
          <Text style={styles.copyText}>{copied ? '\u2713 Copied' : 'Copy to clipboard'}</Text>
        </TouchableOpacity>

        {/* Warning */}
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>Important</Text>
          <Text style={styles.warningText}>
            There is no "forgot password" — if you lose it, no one can recover it.
          </Text>
        </View>

        {/* Signer recommendation */}
        <View style={styles.signerBox}>
          <Text style={styles.signerBoxTitle}>Recommended: use a signer app</Text>
          <Text style={styles.signerBoxText}>
            A signer app holds your key securely. Import this key into {topSigner.name} and
            you won't need to paste it again.
          </Text>
          <SignerRecommendations variant="compact" />
        </View>

        {/* Action buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => setStep('welcome')}>
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, isLoading && styles.disabledBtn]}
            onPress={handleSaved}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryText}>I've saved it</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ---- Welcome / Main Step ----
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Branding */}
      <View style={styles.brandingSection}>
        <Text style={styles.brandEmoji}>📌</Text>
        <Text style={styles.brandName}>corkboards</Text>
        <Text style={styles.brandTagline}>
          No email needed. Just pick a name and you're in.
        </Text>
      </View>

      {/* Create account — name input (main view) */}
      {loginView === 'main' && (
        <>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="What should we call you?"
            placeholderTextColor="#666"
            autoFocus
            autoCapitalize="words"
            maxLength={50}
            returnKeyType="go"
            onSubmitEditing={handleStart}
          />

          <TouchableOpacity
            style={[styles.startBtn, !name.trim() && styles.disabledBtn]}
            onPress={handleStart}
            disabled={!name.trim()}
          >
            <Text style={styles.startBtnText}>Start</Text>
          </TouchableOpacity>

          {/* Login options */}
          <View style={styles.loginOptionsSection}>
            <TouchableOpacity
              style={styles.loginOptionBtn}
              onPress={() => { setLoginView('nsec'); setNsecLoginError(null); }}
            >
              <Text style={styles.loginOptionText}>Log in with nsec password</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Nsec login view */}
      {loginView === 'nsec' && (
        <View style={styles.nsecSection}>
          <TouchableOpacity onPress={() => setLoginView('main')}>
            <Text style={styles.backLinkText}>{'< Back'}</Text>
          </TouchableOpacity>

          <View style={styles.securityNote}>
            <Text style={styles.securityNoteText}>
              <Text style={styles.securityNoteBold}>Stored securely: </Text>
              Your key is saved in the OS keychain, encrypted and hardware-backed.
            </Text>
          </View>

          <Text style={styles.label}>Secret key (nsec)</Text>
          <TextInput
            style={styles.input}
            value={loginNsec}
            onChangeText={(text) => { setLoginNsec(text); setNsecLoginError(null); }}
            placeholder="nsec1..."
            placeholderTextColor="#666"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="go"
            onSubmitEditing={handleNsecLogin}
          />

          {nsecLoginError && <Text style={styles.error}>{nsecLoginError}</Text>}

          <TouchableOpacity
            style={[styles.primaryBtn, nsecLoginLoading && styles.disabledBtn]}
            onPress={handleNsecLogin}
            disabled={nsecLoginLoading}
          >
            {nsecLoginLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryText}>Log in</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Security info link */}
      <View style={styles.securityInfoRow}>
        <SecurityInfoDialog />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
  },
  scrollContent: {
    padding: 24,
    paddingTop: 80,
    paddingBottom: 40,
    gap: 16,
  },
  brandingSection: {
    alignItems: 'center',
    gap: 4,
    marginBottom: 16,
  },
  brandEmoji: {
    fontSize: 40,
    marginBottom: 4,
  },
  brandName: {
    fontSize: 28,
    fontWeight: '700',
    color: '#a855f7',
  },
  brandTagline: {
    color: '#b3b3b3',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
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
    fontSize: 16,
  },
  startBtn: {
    backgroundColor: '#f97316',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  startBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  loginOptionsSection: {
    marginTop: 8,
    gap: 4,
  },
  loginOptionBtn: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  loginOptionText: {
    color: '#999',
    fontSize: 13,
  },
  // Nsec login section
  nsecSection: {
    gap: 12,
  },
  backLinkText: {
    color: '#999',
    fontSize: 13,
    paddingVertical: 4,
  },
  securityNote: {
    backgroundColor: '#1a2a1a',
    borderWidth: 1,
    borderColor: '#2a4a2a',
    borderRadius: 8,
    padding: 12,
  },
  securityNoteText: {
    color: '#4ade80',
    fontSize: 12,
    lineHeight: 17,
  },
  securityNoteBold: {
    fontWeight: '600',
  },
  error: {
    color: '#ef4444',
    fontSize: 13,
  },
  // Key backup step
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f2f2f2',
  },
  subtitle: {
    color: '#b3b3b3',
    fontSize: 14,
    lineHeight: 20,
  },
  keyBox: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  nsec: {
    flex: 1,
    fontSize: 12,
    color: '#ef4444',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  eyeBtn: {
    padding: 6,
    marginLeft: 8,
  },
  eyeText: {
    color: '#999',
    fontSize: 13,
    fontWeight: '500',
  },
  copyBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#333',
    borderRadius: 6,
  },
  copyText: {
    color: '#f97316',
    fontSize: 13,
    fontWeight: '500',
  },
  warningBox: {
    backgroundColor: '#2a1a1a',
    borderWidth: 1,
    borderColor: '#4a2020',
    borderRadius: 8,
    padding: 14,
    gap: 4,
  },
  warningTitle: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '600',
  },
  warningText: {
    color: '#b3b3b3',
    fontSize: 13,
    lineHeight: 18,
  },
  signerBox: {
    backgroundColor: '#1a2a1a',
    borderWidth: 1,
    borderColor: '#2a4a2a',
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  signerBoxTitle: {
    color: '#4ade80',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  signerBoxText: {
    color: '#b3b3b3',
    fontSize: 13,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
  backBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  backText: {
    color: '#b3b3b3',
    fontSize: 15,
  },
  primaryBtn: {
    backgroundColor: '#f97316',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 120,
  },
  disabledBtn: {
    opacity: 0.5,
  },
  primaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  securityInfoRow: {
    alignItems: 'center',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
});
