/**
 * Signup flow — generate keys, set display name, backup nsec.
 * Mirrors the web LoginDialog's two-step process.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';

interface SignupFlowProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function SignupFlow({ onComplete, onCancel }: SignupFlowProps) {
  const { nostr } = useNostr();
  const { loginWithNsec } = useAuth();

  const [step, setStep] = useState<'name' | 'backup'>('name');
  const [displayName, setDisplayName] = useState('');
  const [nsec, setNsec] = useState('');
  const [npub, setNpub] = useState('');
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleContinue = () => {
    if (!displayName.trim()) {
      Alert.alert('Name required', 'Enter a display name to continue');
      return;
    }

    // Generate keys
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const generatedNsec = nip19.nsecEncode(sk);
    const generatedNpub = nip19.npubEncode(pk);

    setNsec(generatedNsec);
    setNpub(generatedNpub);
    setStep('backup');
  };

  const handleCopy = async () => {
    await Clipboard.setStringAsync(nsec);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
    // Auto-clear clipboard after 15 seconds for security
    setTimeout(() => {
      Clipboard.setStringAsync('').catch(() => {});
    }, 15000);
  };

  const handleComplete = async () => {
    setPublishing(true);
    try {
      // Login first (stores key in keychain)
      await loginWithNsec(nsec);

      // Decode key to sign profile event
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') throw new Error('Invalid nsec');

      const { NSecSigner } = await import('@nostrify/nostrify');
      const signer = new NSecSigner(decoded.data);

      // Publish kind 0 (profile metadata)
      const template = {
        kind: 0,
        content: JSON.stringify({
          name: displayName.trim(),
          display_name: displayName.trim(),
        }),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signed = await signer.signEvent(template);
      await nostr.event(signed);

      onComplete();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setPublishing(false);
    }
  };

  // ---- Step 1: Name ----
  if (step === 'name') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>No email required. Your identity lives on Nostr.</Text>

        <TextInput
          style={styles.input}
          placeholder="Display name"
          placeholderTextColor="#666"
          value={displayName}
          onChangeText={setDisplayName}
          autoFocus
          autoCapitalize="words"
          maxLength={50}
        />

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleContinue}>
            <Text style={styles.primaryText}>Continue</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ---- Step 2: Key backup ----
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Save Your Key</Text>
      <Text style={styles.subtitle}>
        This is your private key. It's the only way to log back in.
        There is no "forgot password" — save it now.
      </Text>

      {/* Public key */}
      <Text style={styles.label}>Your public identity</Text>
      <Text style={styles.npub} selectable numberOfLines={2}>{npub}</Text>

      {/* Private key */}
      <Text style={styles.label}>Your private key (keep secret!)</Text>
      <View style={styles.keyBox}>
        <Text style={styles.nsec} selectable={showKey} numberOfLines={showKey ? 3 : 1}>
          {showKey ? nsec : '•'.repeat(40)}
        </Text>
        <TouchableOpacity onPress={() => setShowKey(!showKey)} style={styles.eyeBtn}>
          <Text style={styles.eyeText}>{showKey ? '🙈' : '👁'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.copyBtn} onPress={handleCopy}>
        <Text style={styles.copyText}>{copied ? '✓ Copied' : 'Copy to clipboard'}</Text>
      </TouchableOpacity>

      {/* Warning */}
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>No recovery possible</Text>
        <Text style={styles.warningText}>
          If you lose this key, you lose access to your account forever.
          Paste it somewhere safe — a password manager, a note, anywhere persistent.
        </Text>
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryBtn, publishing && styles.disabledBtn]}
          onPress={handleComplete}
          disabled={publishing}
        >
          {publishing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.primaryText}>I've saved it</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f', padding: 20, paddingTop: 60 },
  scrollContent: { paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#b3b3b3', marginBottom: 24, lineHeight: 20 },
  label: { fontSize: 12, color: '#999', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 14, color: '#f2f2f2', fontSize: 16, marginBottom: 24,
  },
  npub: { fontSize: 12, color: '#999', fontFamily: 'monospace', marginBottom: 20 },
  keyBox: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center',
    marginBottom: 8,
  },
  nsec: { flex: 1, fontSize: 12, color: '#ef4444', fontFamily: 'monospace' },
  eyeBtn: { padding: 4, marginLeft: 8 },
  eyeText: { fontSize: 18 },
  copyBtn: {
    alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 16,
    backgroundColor: '#333', borderRadius: 6, marginBottom: 20,
  },
  copyText: { color: '#f97316', fontSize: 13, fontWeight: '500' },
  warningBox: {
    backgroundColor: '#2a1a1a', borderWidth: 1, borderColor: '#4a2020',
    borderRadius: 8, padding: 14, marginBottom: 24,
  },
  warningTitle: { color: '#ef4444', fontSize: 13, fontWeight: '600', marginBottom: 4 },
  warningText: { color: '#b3b3b3', fontSize: 13, lineHeight: 18 },
  buttonRow: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20 },
  cancelText: { color: '#b3b3b3', fontSize: 15 },
  primaryBtn: {
    backgroundColor: '#f97316', paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: 8, alignItems: 'center', minWidth: 120,
  },
  disabledBtn: { opacity: 0.5 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
