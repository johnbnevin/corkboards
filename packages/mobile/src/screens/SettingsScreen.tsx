import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Modal,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/AuthContext';
import { useAuthor } from '../hooks/useAuthor';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { useNwc } from '../hooks/useNwc';
import { useNostrBackup } from '../hooks/useNostrBackup';
import {
  FALLBACK_RELAYS,
  updateRelayCache,
  APP_CONFIG_KEY,
} from '../lib/NostrProvider';
import { getCurrentPlatform, STORAGE_KEYS } from '../lib/storageKeys';
import { SignupFlow } from '../components/SignupFlow';
import { mobileStorage } from '../storage/MmkvStorage';
import { formatTimeAgo } from '@core/formatTimeAgo';
import type { NSecSigner } from '@nostrify/nostrify';

type ThemeMode = 'dark' | 'light' | 'system';
const THEME_KEY = 'corkboard:theme';

// ============================================================================
// Relay helpers
// ============================================================================

interface RelayEntry { url: string; read: boolean; write: boolean }

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

function saveRelayList(relays: RelayEntry[]): void {
  try {
    const stored = mobileStorage.getSync(APP_CONFIG_KEY);
    const config = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    config.relayMetadata = { relays, updatedAt: Math.floor(Date.now() / 1000) };
    mobileStorage.setSync(APP_CONFIG_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

// ============================================================================
// EditProfileModal
// ============================================================================

interface ProfileFormData {
  display_name: string;
  name: string;
  about: string;
  picture: string;
  website: string;
  lud16: string;
}

function EditProfileModal({
  visible,
  onClose,
  pubkey,
}: {
  visible: boolean;
  onClose: () => void;
  pubkey: string;
}) {
  const { data: authorData } = useAuthor(pubkey);
  const { mutateAsync: publish, isPending } = useNostrPublish();
  const queryClient = useQueryClient();

  const meta = authorData?.metadata;
  const [form, setForm] = useState<ProfileFormData>({
    display_name: meta?.display_name || '',
    name: meta?.name || '',
    about: meta?.about || '',
    picture: meta?.picture || '',
    website: meta?.website || '',
    lud16: meta?.lud16 || '',
  });

  // Re-populate when metadata loads
  const update = (field: keyof ProfileFormData, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    try {
      const metadata: Record<string, string> = {};
      if (form.display_name.trim()) metadata.display_name = form.display_name.trim();
      if (form.name.trim()) metadata.name = form.name.trim();
      if (form.about.trim()) metadata.about = form.about.trim();
      if (form.picture.trim()) metadata.picture = form.picture.trim();
      if (form.website.trim()) metadata.website = form.website.trim();
      if (form.lud16.trim()) metadata.lud16 = form.lud16.trim();

      await publish({
        kind: 0,
        content: JSON.stringify(metadata),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });

      await queryClient.invalidateQueries({ queryKey: ['author', pubkey] });
      Alert.alert('Profile updated', 'Your profile has been published.');
      onClose();
    } catch (err) {
      Alert.alert('Failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <Modal visible={visible} animationType="slide">
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Edit Profile</Text>

        {([
          ['display_name', 'Display name', false],
          ['name', 'Username', false],
          ['about', 'Bio', false],
          ['picture', 'Avatar URL', false],
          ['website', 'Website', false],
          ['lud16', 'Lightning address', false],
        ] as [keyof ProfileFormData, string, boolean][]).map(([field, label]) => (
          <View key={field} style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={styles.input}
              value={form[field]}
              onChangeText={v => update(field, v)}
              placeholder={label}
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}

        <View style={styles.loginButtons}>
          <TouchableOpacity
            style={[styles.button, isPending && styles.buttonDisabled]}
            onPress={handleSave}
            disabled={isPending}
          >
            {isPending
              ? <ActivityIndicator color="#f97316" size="small" />
              : <Text style={styles.buttonText}>Save profile</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </Modal>
  );
}

// ============================================================================
// SettingsScreen
// ============================================================================

export function SettingsScreen() {
  const { pubkey, loginWithNsec, logout, loading: authLoading } = useAuth();
  const { signer } = useAuth();
  const { data: author } = useAuthor(pubkey ?? undefined);
  const { mutateAsync: publish } = useNostrPublish();

  // Auth UI state
  const [nsecInput, setNsecInput] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showSignup, setShowSignup] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);

  // Theme
  const [theme, setThemeState] = useState<ThemeMode>(
    () => (mobileStorage.getSync(THEME_KEY) as ThemeMode) || 'dark',
  );

  // Relays
  const [relayList, setRelayList] = useState<RelayEntry[]>(() => getRelayList());
  const [newRelay, setNewRelay] = useState('');

  // NWC
  const { nwcUri, setNwcUri, isConnected: nwcConnected, walletRelay, disconnect: nwcDisconnect } = useNwc();
  const [nwcInput, setNwcInput] = useState('');

  // Backup
  const { status: backupStatus, message: backupMessage, checkpoints, lastBackupAgo, saveBackup, checkForBackup, restoreBackup } = useNostrBackup(pubkey ?? null, signer as NSecSigner | null);

  const setTheme = (t: ThemeMode) => {
    setThemeState(t);
    mobileStorage.setSync(THEME_KEY, t);
  };

  const handleLogin = async () => {
    const trimmed = nsecInput.trim();
    if (!trimmed.startsWith('nsec1')) {
      Alert.alert('Invalid key', 'Enter a valid nsec (starts with nsec1)');
      return;
    }
    try { nip19.decode(trimmed); } catch {
      Alert.alert('Invalid key', 'Could not decode nsec');
      return;
    }
    setLoggingIn(true);
    try {
      await loginWithNsec(trimmed);
      setNsecInput('');
      setShowLogin(false);
    } catch (err: unknown) {
      Alert.alert('Login failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Log out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => logout() },
    ]);
  };

  const handleAddRelay = async () => {
    let url = newRelay.trim();
    if (!url) return;
    if (!url.startsWith('wss://')) url = 'wss://' + url;

    // Check for duplicate
    if (relayList.some(r => r.url === url)) {
      Alert.alert('Already added', url);
      setNewRelay('');
      return;
    }

    const updated = [...relayList, { url, read: true, write: true }];
    saveRelayList(updated);
    setRelayList(updated);

    if (pubkey) updateRelayCache(pubkey, [url]);

    // Publish NIP-65 kind 10002
    if (signer) {
      try {
        const tags = updated.map(r => ['r', r.url]);
        await publish({ kind: 10002, content: '', tags, created_at: Math.floor(Date.now() / 1000) });
      } catch (err) {
        if (__DEV__) console.warn('[settings] Failed to publish relay list:', err);
      }
    }

    setNewRelay('');
    Alert.alert('Relay added', url);
  };

  const handleRemoveRelay = async (url: string) => {
    Alert.alert('Remove relay', url, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          const updated = relayList.filter(r => r.url !== url);
          saveRelayList(updated);
          setRelayList(updated);

          if (signer && updated.length > 0) {
            try {
              const tags = updated.map(r => ['r', r.url]);
              await publish({ kind: 10002, content: '', tags, created_at: Math.floor(Date.now() / 1000) });
            } catch { /* ignore */ }
          }
        },
      },
    ]);
  };

  const handleNwcConnect = () => {
    const uri = nwcInput.trim();
    if (!uri.startsWith('nostr+walletconnect://')) {
      Alert.alert('Invalid URI', 'Must start with nostr+walletconnect://');
      return;
    }
    try {
      setNwcUri(uri);
      setNwcInput('');
      Alert.alert('Wallet connected', 'Lightning wallet connected successfully.');
    } catch (err) {
      Alert.alert('Invalid URI', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleRestore = (cp: typeof checkpoints[0]) => {
    Alert.alert(
      'Restore backup',
      `Restore backup from ${formatTimeAgo(cp.timestamp)}?\n\nThis will overwrite your current settings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore', onPress: async () => {
            await restoreBackup(cp);
          },
        },
      ],
    );
  };

  if (authLoading) {
    return <View style={styles.center}><ActivityIndicator color="#b3b3b3" /></View>;
  }

  const npub = pubkey ? nip19.npubEncode(pubkey) : null;
  const displayName = author?.metadata?.display_name || author?.metadata?.name || null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.platformLabel}>Platform: {getCurrentPlatform()}</Text>

      {/* ---- Account ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>

        {pubkey ? (
          <>
            {displayName && <Text style={styles.profileName}>{displayName}</Text>}
            <Text style={styles.npub} selectable numberOfLines={1}>{npub}</Text>
            <TouchableOpacity style={styles.button} onPress={() => setShowEditProfile(true)}>
              <Text style={styles.buttonText}>Edit profile</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
              <Text style={styles.logoutText}>Log out</Text>
            </TouchableOpacity>
          </>
        ) : showLogin ? (
          <View style={styles.loginForm}>
            <TextInput
              style={styles.input}
              placeholder="nsec1…"
              placeholderTextColor="#666"
              value={nsecInput}
              onChangeText={setNsecInput}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.loginButtons}>
              <TouchableOpacity
                style={[styles.button, loggingIn && styles.buttonDisabled]}
                onPress={handleLogin}
                disabled={loggingIn}
              >
                {loggingIn
                  ? <ActivityIndicator color="#f97316" size="small" />
                  : <Text style={styles.buttonText}>Log in</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => { setShowLogin(false); setNsecInput(''); }}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            <TouchableOpacity style={styles.button} onPress={() => setShowSignup(true)}>
              <Text style={styles.buttonText}>Create account</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={() => setShowLogin(true)}>
              <Text style={styles.buttonText}>Log in with nsec</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ---- Theme ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Theme</Text>
        <View style={styles.themeRow}>
          {(['dark', 'light', 'system'] as ThemeMode[]).map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.themeBtn, theme === t && styles.themeBtnActive]}
              onPress={() => setTheme(t)}
            >
              <Text style={[styles.themeLabel, theme === t && styles.themeLabelActive]}>
                {t === 'dark' ? '🌙' : t === 'light' ? '☀' : '⚙'} {t}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* ---- Relays ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Relays</Text>
        {relayList.length === 0 && (
          <>
            <Text style={styles.sectionHint}>Default relays (not yet configured):</Text>
            {FALLBACK_RELAYS.map(url => (
              <Text key={url} style={styles.relayItem}>{url}</Text>
            ))}
          </>
        )}
        {relayList.map(relay => (
          <View key={relay.url} style={styles.relayRow}>
            <Text style={styles.relayItemFlex} numberOfLines={1}>{relay.url}</Text>
            <TouchableOpacity onPress={() => handleRemoveRelay(relay.url)}>
              <Text style={styles.relayRemove}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
        <View style={styles.addRelayRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="wss://relay.example.com"
            placeholderTextColor="#666"
            value={newRelay}
            onChangeText={setNewRelay}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.addBtn} onPress={handleAddRelay}>
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ---- Lightning Wallet (NWC) ---- */}
      {pubkey ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lightning Wallet (NWC)</Text>
          {nwcConnected ? (
            <>
              <Text style={styles.info}>Connected to: {walletRelay}</Text>
              <TouchableOpacity style={[styles.button, styles.dangerBtn]} onPress={nwcDisconnect}>
                <Text style={styles.dangerBtnText}>Disconnect wallet</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.sectionHint}>Paste a nostr+walletconnect:// URI to enable zaps.</Text>
              <TextInput
                style={styles.input}
                placeholder="nostr+walletconnect://…"
                placeholderTextColor="#666"
                value={nwcInput}
                onChangeText={setNwcInput}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <TouchableOpacity
                style={[styles.button, !nwcInput.trim() && styles.buttonDisabled]}
                onPress={handleNwcConnect}
                disabled={!nwcInput.trim()}
              >
                <Text style={styles.buttonText}>Connect wallet</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : null}

      {/* ---- Backup / Restore ---- */}
      {pubkey ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Backup</Text>
          {lastBackupAgo && (
            <Text style={styles.info}>Last backup: {lastBackupAgo}</Text>
          )}

          {(backupStatus === 'saving' || backupStatus === 'encrypting' || backupStatus === 'checking' || backupStatus === 'restoring') && (
            <View style={styles.backupStatus}>
              <ActivityIndicator color="#b3b3b3" size="small" />
              <Text style={styles.backupMsg}>{backupMessage}</Text>
            </View>
          )}

          {backupMessage && backupStatus !== 'idle' && backupStatus !== 'saving' && backupStatus !== 'encrypting' && backupStatus !== 'checking' && backupStatus !== 'restoring' && (
            <Text style={[
              styles.backupMsg,
              (backupStatus === 'saved' || backupStatus === 'restored') ? styles.backupSuccess : styles.backupError,
            ]}>
              {backupMessage}
            </Text>
          )}

          <TouchableOpacity
            style={[styles.button, (backupStatus === 'saving' || backupStatus === 'encrypting') && styles.buttonDisabled]}
            onPress={saveBackup}
            disabled={backupStatus === 'saving' || backupStatus === 'encrypting'}
          >
            <Text style={styles.buttonText}>Back up now</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, backupStatus === 'checking' && styles.buttonDisabled]}
            onPress={checkForBackup}
            disabled={backupStatus === 'checking'}
          >
            <Text style={styles.buttonText}>Check for backup</Text>
          </TouchableOpacity>

          {checkpoints.length > 0 && (
            <>
              <Text style={styles.sectionHint}>Available backups:</Text>
              {checkpoints.slice(0, 5).map(cp => (
                <TouchableOpacity key={cp.eventId} style={styles.checkpointRow} onPress={() => handleRestore(cp)}>
                  <Text style={styles.checkpointTime}>{formatTimeAgo(cp.timestamp)}</Text>
                  <Text style={styles.checkpointRestore}>Restore →</Text>
                </TouchableOpacity>
              ))}
            </>
          )}
        </View>
      ) : null}

      {/* ---- Bandwidth ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bandwidth</Text>
        <Text style={styles.sectionHint}>Control image file size limits to save data</Text>
        <Text style={styles.fieldLabel}>Avatar max</Text>
        <View style={styles.themeRow}>
          {([
            { val: 'small', label: '250 KB' },
            { val: 'default', label: '750 KB' },
            { val: 'large', label: '1.5 MB' },
            { val: 'none', label: 'None' },
          ] as const).map(opt => {
            const current = mobileStorage.getSync(STORAGE_KEYS.AVATAR_SIZE_LIMIT) || 'default';
            return (
              <TouchableOpacity
                key={opt.val}
                style={[styles.themeBtn, current === opt.val && styles.themeBtnActive]}
                onPress={() => mobileStorage.setSync(STORAGE_KEYS.AVATAR_SIZE_LIMIT, JSON.stringify(opt.val))}
              >
                <Text style={[styles.themeLabel, current === opt.val && styles.themeLabelActive]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Image max</Text>
        <View style={styles.themeRow}>
          {([
            { val: 'small', label: '750 KB' },
            { val: 'default', label: '2.25 MB' },
            { val: 'large', label: '4.5 MB' },
            { val: 'none', label: 'None' },
          ] as const).map(opt => {
            const current = mobileStorage.getSync(STORAGE_KEYS.IMAGE_SIZE_LIMIT) || 'default';
            return (
              <TouchableOpacity
                key={opt.val}
                style={[styles.themeBtn, current === opt.val && styles.themeBtnActive]}
                onPress={() => mobileStorage.setSync(STORAGE_KEYS.IMAGE_SIZE_LIMIT, JSON.stringify(opt.val))}
              >
                <Text style={[styles.themeLabel, current === opt.val && styles.themeLabelActive]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* ---- About ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <Text style={styles.info}>Corkboards v2.0.0-beta</Text>
        <Text style={styles.info}>Nostr feed reader & builder</Text>
      </View>

      {/* Signup modal */}
      <Modal visible={showSignup} animationType="slide">
        <SignupFlow
          onComplete={() => setShowSignup(false)}
          onCancel={() => setShowSignup(false)}
        />
      </Modal>

      {/* Edit Profile modal */}
      {pubkey && (
        <EditProfileModal
          visible={showEditProfile}
          onClose={() => setShowEditProfile(false)}
          pubkey={pubkey}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  scrollContent: { padding: 20, paddingTop: 60, paddingBottom: 40 },
  center: { flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#f2f2f2', marginBottom: 4 },
  platformLabel: { fontSize: 12, color: '#b3b3b3', marginBottom: 24 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#999', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 },
  sectionHint: { color: '#b3b3b3', fontSize: 12, marginBottom: 8 },
  profileName: { fontSize: 18, fontWeight: '600', color: '#f2f2f2', marginBottom: 4 },
  npub: { fontSize: 12, color: '#b3b3b3', fontFamily: 'monospace', marginBottom: 16 },
  loginForm: { gap: 12 },
  input: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, padding: 14, color: '#f2f2f2', fontSize: 15 },
  loginButtons: { flexDirection: 'row', gap: 8 },
  button: { backgroundColor: '#333', padding: 14, borderRadius: 8, marginBottom: 8, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#f97316', fontSize: 15, fontWeight: '500' },
  cancelBtn: { padding: 14, borderRadius: 8, alignItems: 'center' },
  cancelText: { color: '#b3b3b3', fontSize: 15 },
  logoutBtn: { backgroundColor: '#2a1a1a', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 4 },
  logoutText: { color: '#ef4444', fontSize: 15, fontWeight: '500' },
  dangerBtn: { backgroundColor: '#2a1a1a' },
  dangerBtnText: { color: '#ef4444', fontSize: 15, fontWeight: '500' },
  // Theme
  themeRow: { flexDirection: 'row', gap: 8 },
  themeBtn: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, flex: 1, alignItems: 'center' },
  themeBtnActive: { borderColor: '#22c55e', backgroundColor: '#333' },
  themeLabel: { color: '#b3b3b3', fontSize: 13 },
  themeLabelActive: { color: '#22c55e' },
  // Relays
  relayRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  relayItem: { color: '#b3b3b3', fontSize: 13, fontFamily: 'monospace', marginBottom: 6, paddingLeft: 4 },
  relayItemFlex: { color: '#b3b3b3', fontSize: 13, fontFamily: 'monospace', flex: 1, paddingLeft: 4 },
  relayRemove: { color: '#666', fontSize: 16, paddingHorizontal: 8 },
  addRelayRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  addBtn: { backgroundColor: '#333', paddingHorizontal: 16, borderRadius: 8, justifyContent: 'center' },
  addBtnText: { color: '#f97316', fontSize: 14, fontWeight: '500' },
  // Backup
  backupStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  backupMsg: { color: '#b3b3b3', fontSize: 13, marginBottom: 8 },
  backupSuccess: { color: '#4ade80' },
  backupError: { color: '#f87171' },
  checkpointRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#404040' },
  checkpointTime: { color: '#b3b3b3', fontSize: 13 },
  checkpointRestore: { color: '#f97316', fontSize: 13 },
  // Edit profile modal
  fieldRow: { marginBottom: 16 },
  fieldLabel: { color: '#999', fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  info: { color: '#b3b3b3', fontSize: 13, marginBottom: 4 },
});
