/**
 * Welcome / landing page for unauthenticated users.
 * Mobile port of web's WelcomePage component.
 * Login hierarchy: nsec.app (primary) → Amber → nsec → mnemonic
 */
import { useState, useEffect } from 'react';
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
  Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { nip19 } from 'nostr-tools';
import { privateKeyFromSeedWords, validateWords, generateSeedWords } from 'nostr-tools/nip06';
import { useAuth } from '../../lib/AuthContext';
import { useNostr } from '../../lib/NostrProvider';
import { useSignerConnect } from '../../hooks/useSignerConnect';
import { SecurityInfoDialog } from './SecurityInfoDialog';
import { getTopSignerForPlatform } from './SignerRecommendations';

type Step = 'welcome' | 'key-backup';
type LoginView = 'main' | 'nsec' | 'mnemonic' | 'amber';

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
  const [mnemonic, setMnemonic] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);

  // nsec login state
  const [loginNsec, setLoginNsec] = useState('');
  const [nsecLoginLoading, setNsecLoginLoading] = useState(false);
  const [nsecLoginError, setNsecLoginError] = useState<string | null>(null);

  // mnemonic login state
  const [seedPhrase, setSeedPhrase] = useState('');
  const [seedPassphrase, setSeedPassphrase] = useState('');
  const [seedLoginLoading, setSeedLoginLoading] = useState(false);
  const [seedLoginError, setSeedLoginError] = useState<string | null>(null);

  const amber = useSignerConnect('amber');

  // Clear secrets on unmount
  useEffect(() => {
    return () => { setNsec(''); setLoginNsec(''); };
  }, []);

  const handleStartCreate = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name required', 'Please enter a name to get started.');
      return;
    }
    const words = generateSeedWords();
    const sk = privateKeyFromSeedWords(words);
    setMnemonic(words);
    setNsec(nip19.nsecEncode(sk));
    setStep('key-backup');
  };

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
      setTimeout(() => { Clipboard.setStringAsync('').catch(() => {}); }, 30000);
    } catch {
      Alert.alert('Copy failed', 'Could not copy to clipboard.');
    }
  };

  const handleSaved = async () => {
    setIsLoading(true);
    try {
      await loginWithNsec(nsec);
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
      } catch { /* profile publish is optional */ }
      onComplete?.();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNsecLogin = async () => {
    const trimmed = loginNsec.trim();
    if (!trimmed) { setNsecLoginError('Please enter your nsec key'); return; }
    if (!trimmed.startsWith('nsec1')) { setNsecLoginError('Key must start with nsec1'); return; }
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

  const handleSeedLogin = async () => {
    const words = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!words) { setSeedLoginError('Please enter your seed phrase'); return; }
    if (!validateWords(words)) { setSeedLoginError('Invalid seed phrase — check the words and try again'); return; }
    setSeedLoginLoading(true);
    setSeedLoginError(null);
    try {
      const privateKey = privateKeyFromSeedWords(words, seedPassphrase || undefined);
      await loginWithNsec(nip19.nsecEncode(privateKey));
      onComplete?.();
    } catch (e: unknown) {
      setSeedLoginError((e instanceof Error ? e.message : String(e)) || 'Failed to derive key');
    } finally {
      setSeedLoginLoading(false);
      setSeedPhrase('');
      setSeedPassphrase('');
    }
  };

  const handleAmberConnect = async () => {
    setLoginView('amber');
    try {
      await amber.connect();
      onComplete?.();
    } catch { /* error handled in hook state */ }
  };

  const goBack = () => {
    amber.cancel();
    setLoginView('main');
    setNsecLoginError(null);
    setSeedLoginError(null);
  };

  // ---- Key Backup Step ----
  if (step === 'key-backup') {
    const topSigner = getTopSignerForPlatform();

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Save your password</Text>
        <Text style={styles.subtitle}>
          This is your private key. Save it in your password manager or {topSigner.name}.{'\n'}
          There is no "forgot password" — if you lose it, no one can recover it.
        </Text>

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

        {/* 12-word mnemonic option */}
        <TouchableOpacity style={styles.optionBtn} onPress={() => setShowMnemonicBackup(!showMnemonicBackup)}>
          <Text style={styles.optionText}>{showMnemonicBackup ? 'Hide 12 words' : 'Write down 12 words instead'}</Text>
        </TouchableOpacity>

        {showMnemonicBackup && mnemonic && (
          <View style={styles.mnemonicBox}>
            <Text style={styles.hint}>These 12 words are another form of the same key. Write them down to log in later.</Text>
            <View style={styles.mnemonicGrid}>
              {mnemonic.split(' ').map((word, i) => (
                <View key={`${word}-${i}`} style={styles.mnemonicWord}>
                  <Text style={styles.mnemonicIndex}>{i + 1}.</Text>
                  <Text style={styles.mnemonicText}>{word}</Text>
                </View>
              ))}
            </View>
            <TouchableOpacity style={styles.copyBtn} onPress={async () => {
              await Clipboard.setStringAsync(mnemonic);
              setMnemonicCopied(true);
              setTimeout(() => setMnemonicCopied(false), 3000);
            }}>
              <Text style={styles.copyText}>{mnemonicCopied ? '\u2713 Copied' : 'Copy words'}</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>Important</Text>
          <Text style={styles.warningText}>There is no "forgot password" — if you lose it, no one can recover it.</Text>
        </View>

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => setStep('welcome')}>
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.primaryBtn, isLoading && styles.disabledBtn]} onPress={handleSaved} disabled={isLoading}>
            {isLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryText}>I've saved it</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ---- Welcome Step ----
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Branding */}
      <View style={styles.brandingSection}>
        <Text style={styles.brandEmoji}>📌</Text>
        <Text style={styles.brandName}>corkboards</Text>
        <Text style={styles.brandTagline}>No email needed. Just pick a name and you're in.</Text>
        {loginView === 'main' && (
          <TouchableOpacity onPress={() => Linking.openURL('https://get.corkboards.me')}>
            <Text style={styles.learnMoreLink}>Log in below — or test drive it or download the app here →</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ---- Main view ---- */}
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
            onSubmitEditing={handleStartCreate}
          />
          <TouchableOpacity style={[styles.startBtn, !name.trim() && styles.disabledBtn]} onPress={handleStartCreate} disabled={!name.trim()}>
            <Text style={styles.startBtnText}>Start</Text>
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>already have an account?</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Amber */}
          <TouchableOpacity style={styles.amberBtn} onPress={handleAmberConnect}>
            <Text style={styles.amberBtnText}>
              {Platform.OS === 'android' ? 'Login with Amber' : 'Login with Amber'}
            </Text>
          </TouchableOpacity>

          {/* Secondary options */}
          <View style={styles.loginOptionsSection}>
            <TouchableOpacity style={styles.loginOptionBtn} onPress={() => { setLoginView('nsec'); setNsecLoginError(null); }}>
              <Text style={styles.loginOptionText}>Log in with nsec password</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.loginOptionBtn} onPress={() => { setLoginView('mnemonic'); setSeedLoginError(null); }}>
              <Text style={styles.loginOptionText}>Log in with 12-word mnemonic</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* ---- Amber view ---- */}
      {loginView === 'amber' && (
        <View style={styles.signerSection}>
          <TouchableOpacity onPress={goBack} style={styles.backLinkRow}>
            <Text style={styles.backLinkText}>{'< Back'}</Text>
          </TouchableOpacity>
          <Text style={styles.signerTitle}>Login with Amber</Text>
          <Text style={styles.signerSubtitle}>
            {Platform.OS === 'android'
              ? 'Opening Amber... Approve the connection in Amber and return to this app. If Amber isn\'t installed, you\'ll be taken to the Play Store.'
              : 'Opening your Nostr signer app... Approve the connection and return here.'}
          </Text>
          {amber.connecting && <ActivityIndicator color="#f97316" style={{ marginVertical: 16 }} />}
          {amber.connecting && <Text style={styles.waitingText}>Waiting for Amber to respond...</Text>}
          {amber.error && <Text style={styles.errorText}>{amber.error}</Text>}
          {(amber.connecting || amber.error) && (
            <TouchableOpacity style={styles.cancelBtn} onPress={goBack}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          )}
          {!amber.connecting && !amber.error && (
            <TouchableOpacity style={styles.amberBtn} onPress={handleAmberConnect}>
              <Text style={styles.amberBtnText}>Open Amber</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ---- nsec login view ---- */}
      {loginView === 'nsec' && (
        <View style={styles.nsecSection}>
          <TouchableOpacity onPress={goBack} style={styles.backLinkRow}>
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
            returnKeyType="go"
            onSubmitEditing={handleNsecLogin}
          />
          {nsecLoginError && <Text style={styles.errorText}>{nsecLoginError}</Text>}
          <TouchableOpacity style={[styles.primaryBtn, nsecLoginLoading && styles.disabledBtn]} onPress={handleNsecLogin} disabled={nsecLoginLoading}>
            {nsecLoginLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryText}>Log in</Text>}
          </TouchableOpacity>
        </View>
      )}

      {/* ---- Mnemonic login view ---- */}
      {loginView === 'mnemonic' && (
        <View style={styles.nsecSection}>
          <TouchableOpacity onPress={goBack} style={styles.backLinkRow}>
            <Text style={styles.backLinkText}>{'< Back'}</Text>
          </TouchableOpacity>
          <View style={[styles.securityNote, { borderColor: '#4a3a10', backgroundColor: '#2a2210' }]}>
            <Text style={[styles.securityNoteText, { color: '#d4a040' }]}>
              <Text style={styles.securityNoteBold}>Less secure: </Text>
              Typing your seed phrase into an app exposes it in memory.
            </Text>
          </View>
          <Text style={styles.label}>Seed phrase (12 or 24 words)</Text>
          <TextInput
            style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
            value={seedPhrase}
            onChangeText={setSeedPhrase}
            placeholder="word1 word2 word3 ..."
            placeholderTextColor="#666"
            multiline
            numberOfLines={3}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.fieldLabel}>Passphrase (optional)</Text>
          <TextInput
            style={styles.input}
            value={seedPassphrase}
            onChangeText={setSeedPassphrase}
            placeholder="Leave blank if none"
            placeholderTextColor="#666"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          {seedLoginError && <Text style={styles.errorText}>{seedLoginError}</Text>}
          <TouchableOpacity style={[styles.primaryBtn, seedLoginLoading && styles.disabledBtn]} onPress={handleSeedLogin} disabled={seedLoginLoading}>
            {seedLoginLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryText}>Log in</Text>}
          </TouchableOpacity>
          <Text style={styles.derivationHint}>Derivation path m/44'/1237'/0'/0/0 (NIP-06)</Text>
        </View>
      )}

      {/* Security info */}
      <View style={styles.securityInfoRow}>
        <SecurityInfoDialog />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a' },
  scrollContent: { padding: 24, paddingTop: 80, paddingBottom: 40, gap: 14 },
  brandingSection: { alignItems: 'center', gap: 4, marginBottom: 16 },
  brandEmoji: { fontSize: 40, marginBottom: 4 },
  brandName: { fontSize: 28, fontWeight: '700', color: '#a855f7' },
  brandTagline: { color: '#b3b3b3', fontSize: 14, textAlign: 'center', marginTop: 4 },
  learnMoreLink: { color: '#a855f7', fontSize: 12, textAlign: 'center', marginTop: 8, textDecorationLine: 'underline' },

  label: { color: '#999', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  fieldLabel: { color: '#999', fontSize: 12, marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 14, color: '#f2f2f2', fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  startBtn: { backgroundColor: '#f97316', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  startBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 4 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#404040' },
  dividerText: { color: '#666', fontSize: 11, paddingHorizontal: 10, textTransform: 'uppercase' },

  // Amber button
  amberBtn: {
    backgroundColor: 'transparent', paddingVertical: 14, borderRadius: 8,
    alignItems: 'center', borderWidth: 1, borderColor: '#f97316',
    marginTop: 4,
  },
  amberBtnText: { color: '#f97316', fontSize: 15, fontWeight: '600' },

  loginOptionsSection: { marginTop: 4, gap: 2 },
  loginOptionBtn: { paddingVertical: 10, alignItems: 'center' },
  loginOptionText: { color: '#666', fontSize: 13 },

  // Signer connect views
  signerSection: { gap: 12 },
  signerTitle: { color: '#f2f2f2', fontSize: 18, fontWeight: '700', marginTop: 8 },
  signerSubtitle: { color: '#b3b3b3', fontSize: 13, lineHeight: 19 },
  waitingText: { color: '#b3b3b3', fontSize: 13, textAlign: 'center' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#404040', borderRadius: 8 },
  cancelText: { color: '#b3b3b3', fontSize: 14 },

  // nsec login section
  nsecSection: { gap: 10 },
  backLinkRow: { marginBottom: 4 },
  backLinkText: { color: '#999', fontSize: 13, paddingVertical: 4 },
  securityNote: {
    backgroundColor: '#1a2a1a', borderWidth: 1, borderColor: '#2a4a2a', borderRadius: 8, padding: 12,
  },
  securityNoteText: { color: '#4ade80', fontSize: 12, lineHeight: 17 },
  securityNoteBold: { fontWeight: '600' },
  errorText: { color: '#ef4444', fontSize: 13 },
  derivationHint: { color: '#666', fontSize: 11, textAlign: 'center', marginTop: 4 },

  // Key backup step
  title: { fontSize: 24, fontWeight: '700', color: '#f2f2f2' },
  subtitle: { color: '#b3b3b3', fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 13, color: '#b3b3b3', marginBottom: 12, lineHeight: 18 },
  keyBox: {
    backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040',
    borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'center',
  },
  nsec: { flex: 1, fontSize: 12, color: '#ef4444', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  eyeBtn: { padding: 6, marginLeft: 8 },
  eyeText: { color: '#999', fontSize: 13, fontWeight: '500' },
  copyBtn: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#333', borderRadius: 6 },
  copyText: { color: '#f97316', fontSize: 13, fontWeight: '500' },
  optionBtn: { paddingVertical: 10, alignItems: 'flex-start' },
  optionText: { color: '#f97316', fontSize: 13 },
  mnemonicBox: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, padding: 12, gap: 8 },
  mnemonicGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  mnemonicWord: { flexDirection: 'row', alignItems: 'center', width: '30%', gap: 4 },
  mnemonicIndex: { color: '#999', fontSize: 11, fontFamily: 'monospace', width: 18, textAlign: 'right' },
  mnemonicText: { color: '#f2f2f2', fontSize: 13, fontFamily: 'monospace' },
  warningBox: { backgroundColor: '#2a1a1a', borderWidth: 1, borderColor: '#4a2020', borderRadius: 8, padding: 14, gap: 4 },
  warningTitle: { color: '#ef4444', fontSize: 13, fontWeight: '600' },
  warningText: { color: '#b3b3b3', fontSize: 13, lineHeight: 18 },
  buttonRow: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  backBtn: { paddingVertical: 12, paddingHorizontal: 20 },
  backText: { color: '#b3b3b3', fontSize: 15 },
  primaryBtn: { backgroundColor: '#f97316', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8, alignItems: 'center', minWidth: 120 },
  disabledBtn: { opacity: 0.5 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  securityInfoRow: { alignItems: 'center', marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#333' },
});
