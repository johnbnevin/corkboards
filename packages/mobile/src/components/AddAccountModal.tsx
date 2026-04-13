/**
 * AddAccountModal — modal with all login methods for adding an account.
 * Mirrors web WelcomePage's dialog mode: create new, nsec, mnemonic.
 *
 * Browser extension and QR code / bunker flows are not available on mobile.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools';
import { privateKeyFromSeedWords, validateWords, generateSeedWords } from 'nostr-tools/nip06';
import { useAuth } from '../lib/AuthContext';
import { useNostr } from '../lib/NostrProvider';

type LoginView = 'main' | 'nsec' | 'mnemonic' | 'create-backup';

interface AddAccountModalProps {
  visible: boolean;
  onClose: () => void;
}

export function AddAccountModal({ visible, onClose }: AddAccountModalProps) {
  const { loginWithNsec } = useAuth();
  const { nostr } = useNostr();

  const [view, setView] = useState<LoginView>('main');

  // Create new account state
  const [displayName, setDisplayName] = useState('');
  const [newNsec, setNewNsec] = useState('');
  const [newMnemonic, setNewMnemonic] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);

  // Nsec login state
  const [nsecInput, setNsecInput] = useState('');
  const [nsecLoading, setNsecLoading] = useState(false);
  const [nsecError, setNsecError] = useState<string | null>(null);

  // Mnemonic login state
  const [seedPhrase, setSeedPhrase] = useState('');
  const [seedPassphrase, setSeedPassphrase] = useState('');
  const [seedLoading, setSeedLoading] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

  const reset = () => {
    setView('main');
    setDisplayName('');
    setNewNsec('');
    setNewMnemonic('');
    setShowKey(false);
    setCopied(false);
    setShowMnemonicBackup(false);
    setMnemonicCopied(false);
    setNsecInput('');
    setNsecError(null);
    setSeedPhrase('');
    setSeedPassphrase('');
    setSeedError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // ---- Create new account ----
  const handleCreateStart = () => {
    if (!displayName.trim()) {
      Alert.alert('Name required', 'Enter a display name to continue');
      return;
    }
    const words = generateSeedWords();
    const sk = privateKeyFromSeedWords(words);
    setNewMnemonic(words);
    setNewNsec(nip19.nsecEncode(sk));
    setView('create-backup');
  };

  const handleCopyNsec = async () => {
    await Clipboard.setStringAsync(newNsec);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
    setTimeout(() => { Clipboard.setStringAsync('').catch(() => {}); }, 15000);
  };

  const handleCopyMnemonic = async () => {
    await Clipboard.setStringAsync(newMnemonic);
    setMnemonicCopied(true);
    setTimeout(() => setMnemonicCopied(false), 3000);
  };

  const handleCreateComplete = async () => {
    setPublishing(true);
    try {
      await loginWithNsec(newNsec);

      // Publish kind 0 profile
      const decoded = nip19.decode(newNsec);
      if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
      const { NSecSigner } = await import('@nostrify/nostrify');
      const signer = new NSecSigner(decoded.data);
      const template = {
        kind: 0,
        content: JSON.stringify({ name: displayName.trim(), display_name: displayName.trim() }),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      };
      const signed = await signer.signEvent(template);
      await nostr.event(signed);

      handleClose();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setPublishing(false);
    }
  };

  // ---- Nsec login ----
  const handleNsecLogin = async () => {
    const trimmed = nsecInput.trim();
    if (!trimmed) {
      setNsecError('Please enter your nsec key');
      return;
    }
    if (!trimmed.startsWith('nsec1')) {
      setNsecError('Invalid key — must start with nsec1');
      return;
    }
    setNsecLoading(true);
    setNsecError(null);
    try {
      nip19.decode(trimmed); // validate
      await loginWithNsec(trimmed);
      handleClose();
    } catch (e) {
      setNsecError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setNsecLoading(false);
    }
  };

  // ---- Mnemonic login ----
  const handleSeedLogin = async () => {
    const words = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!words) {
      setSeedError('Please enter your seed phrase');
      return;
    }
    if (!validateWords(words)) {
      setSeedError('Invalid seed phrase — check the words and try again');
      return;
    }
    setSeedLoading(true);
    setSeedError(null);
    try {
      const privateKey = privateKeyFromSeedWords(words, seedPassphrase || undefined);
      await loginWithNsec(nip19.nsecEncode(privateKey));
      handleClose();
    } catch (e) {
      setSeedError(e instanceof Error ? e.message : 'Failed to derive key');
    } finally {
      setSeedLoading(false);
      setSeedPhrase('');
      setSeedPassphrase('');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Add another account</Text>
        <Text style={styles.subtitle}>Create a new account or log in with an existing one.</Text>

        {/* ---- Main view ---- */}
        {view === 'main' && (
          <>
            {/* Create new */}
            <Text style={styles.sectionLabel}>Create new account</Text>
            <TextInput
              style={styles.input}
              placeholder="Display name"
              placeholderTextColor="#666"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
              maxLength={50}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, !displayName.trim() && styles.disabledBtn]}
              onPress={handleCreateStart}
              disabled={!displayName.trim()}
            >
              <Text style={styles.primaryBtnText}>Create</Text>
            </TouchableOpacity>

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or log in</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Login options */}
            <TouchableOpacity style={styles.optionBtn} onPress={() => { setNsecError(null); setView('nsec'); }}>
              <Text style={styles.optionText}>Log in with nsec password</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionBtn} onPress={() => { setSeedError(null); setView('mnemonic'); }}>
              <Text style={styles.optionText}>Log in with 12 word mnemonic</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </>
        )}

        {/* ---- Key backup (after create) ---- */}
        {view === 'create-backup' && (
          <>
            <TouchableOpacity onPress={() => setView('main')} style={styles.backBtn}>
              <Text style={styles.backText}>{'< Back'}</Text>
            </TouchableOpacity>

            <Text style={styles.sectionLabel}>Save your password</Text>
            <Text style={styles.hint}>
              This is your private key. Save it in a password manager or write down the 12 words below.
            </Text>

            {/* Nsec key */}
            <View style={styles.keyBox}>
              <Text style={styles.keyText} selectable={showKey} numberOfLines={showKey ? 3 : 1}>
                {showKey ? newNsec : '\u2022'.repeat(40)}
              </Text>
              <TouchableOpacity onPress={() => setShowKey(!showKey)} style={styles.eyeBtn}>
                <Text style={styles.eyeText}>{showKey ? '🙈' : '👁'}</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.copyBtn} onPress={handleCopyNsec}>
              <Text style={styles.copyText}>{copied ? '✓ Copied' : 'Copy nsec'}</Text>
            </TouchableOpacity>

            {/* 12-word mnemonic */}
            <TouchableOpacity
              style={styles.optionBtn}
              onPress={() => setShowMnemonicBackup(!showMnemonicBackup)}
            >
              <Text style={styles.optionText}>
                {showMnemonicBackup ? 'Hide 12 words' : 'Write down 12 words'}
              </Text>
            </TouchableOpacity>

            {showMnemonicBackup && newMnemonic && (
              <View style={styles.mnemonicBox}>
                <Text style={styles.hint}>
                  These 12 words are another form of the same password. Write them down to log in later.
                </Text>
                <View style={styles.mnemonicGrid}>
                  {newMnemonic.split(' ').map((word, i) => (
                    <View key={`${word}-${i}`} style={styles.mnemonicWord}>
                      <Text style={styles.mnemonicIndex}>{i + 1}.</Text>
                      <Text style={styles.mnemonicText}>{word}</Text>
                    </View>
                  ))}
                </View>
                <TouchableOpacity style={styles.copyBtn} onPress={handleCopyMnemonic}>
                  <Text style={styles.copyText}>{mnemonicCopied ? '✓ Copied' : 'Copy words'}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Warning */}
            <View style={styles.warningBox}>
              <Text style={styles.warningTitle}>No recovery possible</Text>
              <Text style={styles.warningText}>
                If you lose this key, you lose access forever. There is no "forgot password."
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, publishing && styles.disabledBtn]}
              onPress={handleCreateComplete}
              disabled={publishing}
            >
              {publishing ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>I've saved it</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {/* ---- Nsec login ---- */}
        {view === 'nsec' && (
          <>
            <TouchableOpacity onPress={() => setView('main')} style={styles.backBtn}>
              <Text style={styles.backText}>{'< Back'}</Text>
            </TouchableOpacity>

            <View style={styles.warningBoxAmber}>
              <Text style={styles.warningTextAmber}>
                <Text style={styles.bold}>Less secure: </Text>
                Pasting your key into an app exposes it in memory.
                For better security, consider using a signer app.
              </Text>
            </View>

            <Text style={styles.sectionLabel}>Secret key (nsec)</Text>
            <TextInput
              style={styles.input}
              placeholder="nsec1..."
              placeholderTextColor="#666"
              value={nsecInput}
              onChangeText={setNsecInput}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            {nsecError && <Text style={styles.errorText}>{nsecError}</Text>}
            <TouchableOpacity
              style={[styles.primaryBtn, nsecLoading && styles.disabledBtn]}
              onPress={handleNsecLogin}
              disabled={nsecLoading}
            >
              {nsecLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Log in</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {/* ---- Mnemonic login ---- */}
        {view === 'mnemonic' && (
          <>
            <TouchableOpacity onPress={() => setView('main')} style={styles.backBtn}>
              <Text style={styles.backText}>{'< Back'}</Text>
            </TouchableOpacity>

            <View style={styles.warningBoxAmber}>
              <Text style={styles.warningTextAmber}>
                <Text style={styles.bold}>Less secure: </Text>
                Typing your seed phrase into an app exposes it in memory.
                For better security, consider using a signer app.
              </Text>
            </View>

            <Text style={styles.sectionLabel}>Seed phrase (12 or 24 words)</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="word1 word2 word3 ..."
              placeholderTextColor="#666"
              value={seedPhrase}
              onChangeText={setSeedPhrase}
              multiline
              numberOfLines={3}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.fieldLabel}>Passphrase (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Leave blank if none"
              placeholderTextColor="#666"
              value={seedPassphrase}
              onChangeText={setSeedPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />

            {seedError && <Text style={styles.errorText}>{seedError}</Text>}
            <TouchableOpacity
              style={[styles.primaryBtn, seedLoading && styles.disabledBtn]}
              onPress={handleSeedLogin}
              disabled={seedLoading}
            >
              {seedLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Log in</Text>
              )}
            </TouchableOpacity>
            <Text style={styles.derivationHint}>
              Uses derivation path m/44'/1237'/0'/0/0 (NIP-06)
            </Text>
          </>
        )}
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  scrollContent: { padding: 20, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#f2f2f2', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#b3b3b3', marginBottom: 24 },

  sectionLabel: {
    fontSize: 12, color: '#999', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8, marginTop: 8,
  },
  fieldLabel: {
    fontSize: 12, color: '#999',
    marginBottom: 6, marginTop: 12,
  },
  hint: { fontSize: 13, color: '#b3b3b3', marginBottom: 12, lineHeight: 18 },

  input: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 14, color: '#f2f2f2', fontSize: 15,
    marginBottom: 12, fontFamily: 'monospace',
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },

  primaryBtn: {
    backgroundColor: '#f97316', padding: 14, borderRadius: 8,
    alignItems: 'center', marginBottom: 8,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabledBtn: { opacity: 0.5 },

  optionBtn: {
    backgroundColor: '#333', padding: 14, borderRadius: 8,
    alignItems: 'center', marginBottom: 8,
  },
  optionText: { color: '#f97316', fontSize: 14, fontWeight: '500' },

  cancelBtn: { padding: 14, alignItems: 'center', marginTop: 8 },
  cancelText: { color: '#b3b3b3', fontSize: 15 },

  backBtn: { marginBottom: 16 },
  backText: { color: '#b3b3b3', fontSize: 14 },

  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#404040' },
  dividerText: { color: '#999', fontSize: 12, paddingHorizontal: 12, textTransform: 'uppercase' },

  // Key display
  keyBox: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center',
    marginBottom: 8,
  },
  keyText: { flex: 1, fontSize: 12, color: '#ef4444', fontFamily: 'monospace' },
  eyeBtn: { padding: 4, marginLeft: 8 },
  eyeText: { fontSize: 18 },
  copyBtn: {
    alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 16,
    backgroundColor: '#333', borderRadius: 6, marginBottom: 12,
  },
  copyText: { color: '#f97316', fontSize: 13, fontWeight: '500' },

  // Mnemonic
  mnemonicBox: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 12, marginBottom: 12,
  },
  mnemonicGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  mnemonicWord: { flexDirection: 'row', alignItems: 'center', width: '30%', gap: 4 },
  mnemonicIndex: { color: '#999', fontSize: 11, fontFamily: 'monospace', width: 18, textAlign: 'right' },
  mnemonicText: { color: '#f2f2f2', fontSize: 13, fontFamily: 'monospace' },

  // Warnings
  warningBox: {
    backgroundColor: '#2a1a1a', borderWidth: 1, borderColor: '#4a2020',
    borderRadius: 8, padding: 14, marginBottom: 16, marginTop: 8,
  },
  warningTitle: { color: '#ef4444', fontSize: 13, fontWeight: '600', marginBottom: 4 },
  warningText: { color: '#b3b3b3', fontSize: 13, lineHeight: 18 },

  warningBoxAmber: {
    backgroundColor: '#2a2210', borderWidth: 1, borderColor: '#4a3a10',
    borderRadius: 8, padding: 14, marginBottom: 16,
  },
  warningTextAmber: { color: '#d4a040', fontSize: 13, lineHeight: 18 },
  bold: { fontWeight: '600' },

  errorText: { color: '#ef4444', fontSize: 13, marginBottom: 8 },
  derivationHint: { color: '#999', fontSize: 11, textAlign: 'center', marginTop: 4 },
});
