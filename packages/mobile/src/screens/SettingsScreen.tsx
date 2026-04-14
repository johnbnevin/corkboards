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
import { useNostrBackup, getBlossomServers, setBlossomServers, DEFAULT_BLOSSOM_SERVERS } from '../hooks/useNostrBackup';
import { useContacts } from '../hooks/useFeed';
import {
  FALLBACK_RELAYS,
  updateRelayCache,
  APP_CONFIG_KEY,
} from '../lib/NostrProvider';
import { getCurrentPlatform, STORAGE_KEYS } from '../lib/storageKeys';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { SignupFlow } from '../components/SignupFlow';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { AddAccountModal } from '../components/AddAccountModal';
import { ProfileCacheSettings } from '../components/ProfileCacheSettings';
import { ThroughputSettings } from '../components/ThroughputSettings';
import { EmojiSetEditor } from '../components/EmojiSetEditor';
import { useAppContext } from '../hooks/useAppContext';
import { useFeedLimit } from '../hooks/useFeedLimit';
import { useImageSizeLimitSetting, useAvatarSizeLimitSetting } from '../hooks/useImageSizeLimit';
import { usePlatformStorage } from '../hooks/usePlatformStorage';
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
  const { pubkey, loginWithNsec, logout, accounts, loading: authLoading } = useAuth();
  const { signer } = useAuth();
  const { data: author } = useAuthor(pubkey ?? undefined);
  const { data: contacts } = useContacts(pubkey ?? undefined);
  const { mutateAsync: publish } = useNostrPublish();

  // AppContext for client tag
  const { config, updateConfig } = useAppContext();

  // Throughput settings hooks
  const { multiplier, setMultiplier } = useFeedLimit();
  const [avatarSizeLimit, setAvatarSizeLimit] = useAvatarSizeLimitSetting();
  const [imageSizeLimit, setImageSizeLimit] = useImageSizeLimitSetting();
  const [autofetchInterval, setAutofetchInterval] = usePlatformStorage<number>(
    STORAGE_KEYS.AUTOFETCH_INTERVAL_SECS,
    120,
  );

  // Auth UI state
  const [nsecInput, setNsecInput] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showSignup, setShowSignup] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showEmojiEditor, setShowEmojiEditor] = useState(false);
  const [showProfileCache, setShowProfileCache] = useState(false);

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

  // Onboarding state — mirrors web's MultiColumnClient onboarding logic
  const [onboardingSkipped, setOnboardingSkipped] = useLocalStorage<boolean>(STORAGE_KEYS.ONBOARDING_SKIPPED, false);
  const [onboardFollowTarget, setOnboardFollowTarget] = useLocalStorage<number>(STORAGE_KEYS.ONBOARDING_FOLLOW_TARGET, 10);

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
            {/* Account switcher (shows current + other accounts + add/logout) */}
            {accounts.length > 0 && (
              <AccountSwitcher
                onAddAccount={() => setShowAddAccount(true)}
                onLogout={handleLogout}
              />
            )}
            <View style={{ height: 12 }} />
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
            <TouchableOpacity style={styles.button} onPress={() => setShowAddAccount(true)}>
              <Text style={styles.buttonText}>Log in with existing account</Text>
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

      {/* ---- Bandwidth & Performance (ThroughputSettings) ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bandwidth & Performance</Text>
        <Text style={styles.sectionHint}>Control feed load, refresh rate, and image sizes</Text>
        <ThroughputSettings
          multiplier={multiplier}
          onMultiplierChange={setMultiplier}
          autofetchIntervalSecs={autofetchInterval}
          onAutofetchIntervalChange={setAutofetchInterval}
          avatarSizeLimit={avatarSizeLimit}
          onAvatarSizeLimitChange={setAvatarSizeLimit}
          imageSizeLimit={imageSizeLimit}
          onImageSizeLimitChange={setImageSizeLimit}
        />
      </View>

      {/* ---- Custom Emoji Sets ---- */}
      {pubkey ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Custom Emoji Sets</Text>
          <Text style={styles.sectionHint}>Create and manage NIP-30 custom emoji sets</Text>
          <TouchableOpacity style={styles.button} onPress={() => setShowEmojiEditor(true)}>
            <Text style={styles.buttonText}>Open Emoji Set Editor</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ---- Profile Cache ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Profile Cache</Text>
        <Text style={styles.sectionHint}>Manage locally cached profile metadata</Text>
        {showProfileCache ? (
          <>
            <ProfileCacheSettings />
            <TouchableOpacity
              style={[styles.button, { marginTop: 8 }]}
              onPress={() => setShowProfileCache(false)}
            >
              <Text style={styles.cancelText}>Hide</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity style={styles.button} onPress={() => setShowProfileCache(true)}>
            <Text style={styles.buttonText}>View Cache Stats</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ---- Client Tag ---- */}
      {pubkey ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Publishing</Text>
          <TouchableOpacity
            style={styles.clientTagRow}
            onPress={() => {
              const current = config.publishClientTag !== false;
              Alert.alert(
                current ? 'Disable client tag?' : 'Enable client tag?',
                current
                  ? 'Your posts will no longer include a tag identifying Corkboards as the client.'
                  : 'Your posts will include a tag identifying Corkboards as the client. This helps the Nostr ecosystem track client diversity.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: current ? 'Disable' : 'Enable',
                    onPress: () => updateConfig(c => ({ ...c, publishClientTag: !current })),
                  },
                ],
              );
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.clientTagTitle}>
                {config.publishClientTag !== false ? '\u2713 ' : ''}Client Tag
              </Text>
              <Text style={styles.clientTagHint}>
                Tag your posts as "sent from Corkboards"
              </Text>
            </View>
            <View style={[
              styles.toggleDot,
              config.publishClientTag !== false ? styles.toggleDotOn : styles.toggleDotOff,
            ]} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ---- Advanced ---- */}
      {pubkey ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Advanced</Text>

          {/* Dismissed notes */}
          <TouchableOpacity style={styles.button} onPress={() => {
            const raw = mobileStorage.getSync(STORAGE_KEYS.DISMISSED_NOTES);
            const dismissed = raw ? JSON.parse(raw) as string[] : [];
            if (dismissed.length === 0) {
              Alert.alert('No dismissed notes', 'There are no dismissed notes to restore.');
            } else {
              Alert.alert(
                'Restore dismissed notes',
                `Bring back ${dismissed.length} dismissed note${dismissed.length === 1 ? '' : 's'}?`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Restore', onPress: () => { mobileStorage.removeSync(STORAGE_KEYS.DISMISSED_NOTES); Alert.alert('Restored', 'Dismissed notes have been restored.'); } },
                ],
              );
            }
          }}>
            <Text style={styles.buttonText}>Restore dismissed notes</Text>
          </TouchableOpacity>

          {/* Public bookmarks toggle */}
          <TouchableOpacity style={styles.button} onPress={() => {
            const current = mobileStorage.getSync(STORAGE_KEYS.PUBLIC_BOOKMARKS) === 'true';
            const newVal = !current;
            Alert.alert(
              newVal ? 'Make bookmarks public?' : 'Make bookmarks private?',
              newVal
                ? 'Your saved notes will be visible to anyone. Private is recommended.'
                : 'Your saved notes will be encrypted and only visible to you.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: newVal ? 'Make public' : 'Make private', onPress: () => mobileStorage.setSync(STORAGE_KEYS.PUBLIC_BOOKMARKS, String(newVal)) },
              ],
            );
          }}>
            <Text style={styles.buttonText}>
              Bookmark privacy: {mobileStorage.getSync(STORAGE_KEYS.PUBLIC_BOOKMARKS) === 'true' ? 'Public' : 'Private'}
            </Text>
          </TouchableOpacity>

          {/* Blossom servers */}
          <BlossomServerSettings />

          {/* Restart onboarding */}
          {contacts !== undefined && (contacts.length >= onboardFollowTarget || onboardingSkipped) && (
            <TouchableOpacity style={styles.button} onPress={() => {
              setOnboardFollowTarget((contacts?.length ?? 0) + 10);
              setOnboardingSkipped(false);
              Alert.alert('Onboarding restarted', 'Go to Discover to follow 10 more people.');
            }}>
              <Text style={styles.buttonText}>Restart Onboarding</Text>
              <Text style={[styles.buttonText, { fontSize: 11, color: '#888', marginTop: 2 }]}>Show the discover/follow guide again</Text>
            </TouchableOpacity>
          )}

          {/* Delete account */}
          <TouchableOpacity style={[styles.button, styles.dangerBtn]} onPress={() => {
            Alert.alert(
              'Delete account',
              'This broadcasts a deletion event (kind 5) to relays. Your key still works, but clients that respect NIP-09 will hide your content. This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete', style: 'destructive', onPress: async () => {
                    try {
                      await publish({ kind: 5, content: 'Account deletion requested', tags: [], created_at: Math.floor(Date.now() / 1000) });
                      Alert.alert('Account deleted', 'Deletion event broadcast. Logging out.');
                      logout();
                    } catch (err) {
                      Alert.alert('Failed', err instanceof Error ? err.message : 'Unknown error');
                    }
                  },
                },
              ],
            );
          }}>
            <Text style={styles.dangerBtnText}>Delete account</Text>
          </TouchableOpacity>
        </View>
      ) : null}

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

      {/* Add account modal (all login methods) */}
      <AddAccountModal
        visible={showAddAccount}
        onClose={() => setShowAddAccount(false)}
      />

      {/* Edit Profile modal */}
      {pubkey && (
        <EditProfileModal
          visible={showEditProfile}
          onClose={() => setShowEditProfile(false)}
          pubkey={pubkey}
        />
      )}

      {/* Emoji Set Editor modal */}
      <Modal visible={showEmojiEditor} animationType="slide">
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowEmojiEditor(false)}>
              <Text style={styles.modalCloseText}>{'<'} Back</Text>
            </TouchableOpacity>
          </View>
          <EmojiSetEditor />
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Blossom Server Settings (inline in Advanced section) ────────────────

function BlossomServerSettings() {
  const [servers, setServersState] = useState<string[]>(getBlossomServers);
  const [newUrl, setNewUrl] = useState('');
  const [expanded, setExpanded] = useState(false);

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
    if (servers.length <= 1) return;
    const updated = servers.filter(s => s !== url);
    setServersState(updated);
    setBlossomServers(updated);
  };

  const handleResetDefaults = () => {
    setServersState([...DEFAULT_BLOSSOM_SERVERS]);
    setBlossomServers([...DEFAULT_BLOSSOM_SERVERS]);
  };

  return (
    <View style={{ marginBottom: 12 }}>
      <TouchableOpacity style={blossomStyles.header} onPress={() => setExpanded(!expanded)}>
        <Text style={blossomStyles.headerText}>Blossom Servers ({servers.length})</Text>
        <Text style={blossomStyles.expandIcon}>{expanded ? '▼' : '▶'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={blossomStyles.content}>
          <Text style={blossomStyles.hint}>Encrypted backup storage servers. Tried in order.</Text>

          {servers.map((url, i) => {
            const isDefault = DEFAULT_BLOSSOM_SERVERS.includes(url);
            return (
              <View key={url} style={blossomStyles.serverRow}>
                <Text style={blossomStyles.serverUrl} numberOfLines={1}>
                  #{i + 1} {getHostname(url)}{isDefault ? ' (default)' : ''}
                </Text>
                <TouchableOpacity
                  onPress={() => handleRemove(url)}
                  disabled={servers.length <= 1}
                >
                  <Text style={[blossomStyles.removeText, servers.length <= 1 && { opacity: 0.3 }]}>✕</Text>
                </TouchableOpacity>
              </View>
            );
          })}

          <View style={blossomStyles.addRow}>
            <TextInput
              style={blossomStyles.addInput}
              placeholder="https://blossom.example.com"
              placeholderTextColor="#666"
              value={newUrl}
              onChangeText={setNewUrl}
              onSubmitEditing={handleAdd}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={blossomStyles.addBtn} onPress={handleAdd}>
              <Text style={blossomStyles.addBtnText}>Add</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={blossomStyles.resetBtn} onPress={handleResetDefaults}>
            <Text style={blossomStyles.resetText}>Reset to defaults</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const blossomStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#333',
    padding: 14,
    borderRadius: 8,
  },
  headerText: { color: '#f97316', fontSize: 15, fontWeight: '500' },
  expandIcon: { color: '#888', fontSize: 12 },
  content: { paddingHorizontal: 8, paddingTop: 8 },
  hint: { color: '#888', fontSize: 12, marginBottom: 8 },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  serverUrl: { color: '#b3b3b3', fontSize: 13, fontFamily: 'monospace', flex: 1 },
  removeText: { color: '#888', fontSize: 16, paddingHorizontal: 8 },
  addRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
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
  addBtn: { backgroundColor: '#333', paddingHorizontal: 16, borderRadius: 8, justifyContent: 'center' },
  addBtnText: { color: '#f97316', fontSize: 14, fontWeight: '500' },
  resetBtn: { marginTop: 8, padding: 8, alignItems: 'center' },
  resetText: { color: '#a855f7', fontSize: 13 },
});

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
  // Client tag toggle
  clientTagRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#404040', borderRadius: 8, padding: 14, gap: 12 },
  clientTagTitle: { color: '#f2f2f2', fontSize: 14, fontWeight: '500' },
  clientTagHint: { color: '#888', fontSize: 12, marginTop: 2 },
  toggleDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2 },
  toggleDotOn: { backgroundColor: '#22c55e', borderColor: '#22c55e' },
  toggleDotOff: { backgroundColor: 'transparent', borderColor: '#666' },
  // Emoji editor modal
  modalContainer: { flex: 1, backgroundColor: '#1f1f1f', paddingTop: 60, paddingHorizontal: 16 },
  modalHeader: { marginBottom: 16 },
  modalCloseText: { color: '#a855f7', fontSize: 16, fontWeight: '500' },
});
