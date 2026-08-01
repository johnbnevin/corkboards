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
import { useAuth } from '../lib/AuthContext';
import { getOnboarded, clearOnboarded } from '../lib/onboardingFlag';
import { useAuthor } from '../hooks/useAuthor';
import { useNostrPublish } from '../hooks/useNostrPublish';
import { useNostr } from '../lib/NostrProvider';
import { useNwc } from '../hooks/useNwc';
import { useNostrBackup } from '../hooks/useNostrBackup';
import { useContacts } from '../hooks/useFeed';
import { getCurrentPlatform, STORAGE_KEYS } from '../lib/storageKeys';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { SignupFlow } from '../components/SignupFlow';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { AddAccountModal } from '../components/AddAccountModal';
import { ProfileCacheSettings } from '../components/ProfileCacheSettings';
import { ThroughputSettings } from '../components/ThroughputSettings';
import { EmojiSetEditor } from '../components/EmojiSetEditor';
import { EditProfileForm } from '../components/EditProfileForm';
import { AdvancedSettings } from '../components/AdvancedSettings';
import { RelayListManager } from '../components/RelayListManager';
import { ScanToZapDialog } from '../components/ScanToZapDialog';
import { useCollapsedNotes } from '../hooks/useCollapsedNotes';
import { useBookmarks } from '../hooks/useBookmarks';
import { useAppContext } from '../hooks/useAppContext';
import { useFeedLimit } from '../hooks/useFeedLimit';
import { useImageSizeLimitSetting, useAvatarSizeLimitSetting } from '../hooks/useImageSizeLimit';
import { usePlatformStorage } from '../hooks/usePlatformStorage';
import { mobileStorage } from '../storage/MmkvStorage';
import { formatTimeAgo } from '@core/formatTimeAgo';
import { genUserName } from '@core/genUserName';
import type { NSecSigner } from '@nostrify/nostrify';

type ThemeMode = 'dark' | 'light' | 'system';
const THEME_KEY = 'corkboard:theme';

// ============================================================================
// SettingsScreen
// ============================================================================

export function SettingsScreen() {
  const { pubkey, loginWithNsec, logout, accounts, loading: authLoading } = useAuth();
  const { signer } = useAuth();
  const { data: author } = useAuthor(pubkey ?? undefined);
  const { data: contacts } = useContacts(pubkey ?? undefined);
  const { mutateAsync: publish } = useNostrPublish();
  const { nostr } = useNostr();

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
  // Phones are the "small screen" case, so this shares web's small-screen
  // autofetch key — a user who enabled it on mobile web gets it here too.
  const [autofetchEnabled, setAutofetchEnabled] = usePlatformStorage<boolean>(
    STORAGE_KEYS.AUTOFETCH_SMALL,
    false,
  );
  // Jump to the top when new notes arrive (shares web's AUTO_SCROLL_TOP key).
  const [autoScrollTop, setAutoScrollTop] = usePlatformStorage<boolean>(
    STORAGE_KEYS.AUTO_SCROLL_TOP,
    false,
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

  // Dismissed notes — via the shared hook so open feeds update immediately
  // when notes are restored (raw MMKV writes bypass module state).
  const { dismissedIds, dismissedCount, clearDismissed, undismissMany } = useCollapsedNotes();

  // Bookmark privacy — state (not a raw storage read during render) so the
  // label updates; republishBookmarks re-publishes the list on toggle.
  const [publicBookmarks, setPublicBookmarks] = useLocalStorage<boolean>(STORAGE_KEYS.PUBLIC_BOOKMARKS, false);
  const { republishBookmarks } = useBookmarks();

  // NWC — nwcUri is read elsewhere via useNwc; the destructure here is just
  // for the setter/connect helpers used in the form below.
  const { nwcUri: _nwcUri, setNwcUri, isConnected: nwcConnected, walletRelay, disconnect: nwcDisconnect } = useNwc();
  const [nwcInput, setNwcInput] = useState('');
  const [scanToZapVisible, setScanToZapVisible] = useState(false);

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

  // Restore all dismissed notes (confirmation handled by AdvancedSettings)
  const handleClearDismissed = () => {
    clearDismissed();
    Alert.alert('Restored', 'Dismissed notes have been restored.');
  };

  // Restore only the dismissed notes the user authored
  const handleRestoreOwnDismissed = async () => {
    if (!pubkey || dismissedIds.length === 0) return;
    // One batched query per chunk: { ids, authors:[me] } AND-matches the
    // dismissed id-set with our pubkey, so we un-dismiss only our own.
    const own = new Set<string>();
    const CHUNK = 200;
    for (let i = 0; i < dismissedIds.length; i += CHUNK) {
      const chunk = dismissedIds.slice(i, i + CHUNK);
      try {
        const events = await nostr.query([{ ids: chunk, authors: [pubkey] }], { signal: AbortSignal.timeout(6000) });
        for (const e of events) own.add(e.id);
      } catch { /* ignore this chunk */ }
    }
    if (own.size === 0) {
      Alert.alert('None found', 'None of your dismissed notes could be found on your relays.');
      return;
    }
    undismissMany([...own]);
    Alert.alert('Restored', `Restored ${own.size} of your note${own.size === 1 ? '' : 's'}.`);
  };

  // Toggle bookmark privacy, then re-publish the kind 10003 list so its
  // public/private shape matches the new preference (parity with web).
  const handleTogglePublicBookmarks = () => {
    setPublicBookmarks(!publicBookmarks);
    setTimeout(republishBookmarks, 500);
  };

  /**
   * Delete account.
   *
   * Two mechanisms, because neither alone does the job:
   *
   *  - NIP-62 kind 62 "request to vanish" with `["relay","ALL_RELAYS"]` asks
   *    every relay to erase *everything* this pubkey ever wrote, including the
   *    kind-5s themselves. It is the only thing here that covers notes,
   *    reactions, zaps and gift wraps rather than a hand-listed set, and NIP-62
   *    says clients SHOULD broadcast it as widely as possible.
   *  - NIP-09 kind 5 deletions stay as well, because kind 62 is `draft` and
   *    unevenly implemented; a relay that ignores it may still honour a kind 5.
   *
   * `a` coordinates are used ONLY for the addressable events (30000–39999),
   * which is the only range where a `kind:pubkey:d` coordinate has meaning. The
   * previous code also emitted `a` tags for kinds 0, 3 and 10002 — those are
   * *replaceable*, not addressable, so `0:<pubkey>:` addresses nothing and a
   * conforming relay drops the request on the floor. Replaceable events are
   * deleted with a `k` tag (the kind) instead, per NIP-09.
   *
   * The alert says "requests broadcast", not "deleted": NIP-09 and NIP-62 both
   * ask, and relays may refuse. Telling a user their data is gone when we only
   * asked politely would be a lie.
   */
  const handleDeleteAccount = async () => {
    if (!pubkey || !signer) return;
    const now = Math.floor(Date.now() / 1000);

    // NIP-62 first — the broad request, before the narrow ones.
    try {
      await publish({
        kind: 62,
        content: 'Account deleted by owner. Please erase all events for this pubkey.',
        tags: [['relay', 'ALL_RELAYS']],
        created_at: now,
      });
    } catch { /* best effort — fall through to the kind-5s */ }

    // Replaceable events: identified by kind alone.
    const replaceableKinds = [0, 3, 10002];
    try {
      await publish({
        kind: 5,
        content: 'Account deleted by owner',
        tags: replaceableKinds.map(kind => ['k', String(kind)]),
        created_at: now,
      });
    } catch { /* best effort */ }

    // Addressable events: `a` coordinates are meaningful here.
    // Kinds/d-tags kept in step with the NIP-78 migration in the sync hooks —
    // the legacy 35571/35572 events still exist on relays, so they still need
    // deleting alongside the 30078 ones that replaced them.
    const addressableTargets: Array<{ kind: number; dTag: string }> = [
      { kind: 30078, dTag: 'corkboard:backup' },
      { kind: 30078, dTag: 'corkboard:feeds' },
      { kind: 30078, dTag: 'corkboard:dismissed' },
      { kind: 35571, dTag: 'corkboard:feeds' },
      { kind: 35572, dTag: 'corkboard:dismissed' },
    ];
    for (const { kind, dTag } of addressableTargets) {
      try {
        await publish({
          kind: 5,
          content: 'Account deleted by owner',
          tags: [['a', `${kind}:${pubkey}:${dTag}`], ['k', String(kind)]],
          created_at: now,
        });
      } catch { /* best effort — continue with remaining targets */ }
    }

    Alert.alert(
      'Deletion requested',
      'Vanish and deletion requests were broadcast to relays. Relays may refuse or may not implement them, so copies can survive. Logging out.',
    );
    logout();
  };

  const handleResetOnboarding = () => {
    setOnboardFollowTarget((contacts?.length ?? 0) + 10);
    setOnboardingSkipped(false);
    if (pubkey) clearOnboarded(pubkey);
    Alert.alert('Onboarding restarted', 'Go to Discover to follow 10 more people.');
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
  const displayName = author?.metadata?.display_name || author?.metadata?.name
    || (pubkey ? genUserName(pubkey) : null);

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

      {/* ---- Relays (read/write toggles, marker-preserving NIP-65 publish) ---- */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Relays</Text>
        <RelayListManager />
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
          {/* Pay a Lightning QR code (invoice / LNURL / address). Standalone —
              not tied to a note, so it's a plain payment, not a NIP-57 zap. */}
          <TouchableOpacity style={styles.button} onPress={() => setScanToZapVisible(true)}>
            <Text style={styles.buttonText}>Scan to zap</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ScanToZapDialog
        visible={scanToZapVisible}
        onClose={() => setScanToZapVisible(false)}
      />

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
          autofetchEnabled={autofetchEnabled}
          onAutofetchEnabledChange={setAutofetchEnabled}
          autofetchIntervalSecs={autofetchInterval}
          onAutofetchIntervalChange={setAutofetchInterval}
          autoScrollTop={autoScrollTop}
          onAutoScrollTopChange={setAutoScrollTop}
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

      {/* ---- Advanced (mounts the AdvancedSettings panel: relaunch of
           dismissed-note restore, client tag, bookmark privacy, blossom,
           network privacy / image proxy, onboarding, delete account) ---- */}
      {pubkey ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Advanced</Text>
          <AdvancedSettings
            dismissedCount={dismissedCount}
            onClearDismissed={handleClearDismissed}
            onRestoreOwnDismissed={handleRestoreOwnDismissed}
            onOpenProfileCache={() => setShowProfileCache(true)}
            publishClientTag={config.publishClientTag === true}
            onToggleClientTag={() => updateConfig(c => ({ ...c, publishClientTag: !(c.publishClientTag === true) }))}
            publicBookmarks={publicBookmarks}
            onTogglePublicBookmarks={handleTogglePublicBookmarks}
            onDeleteAccount={handleDeleteAccount}
            isOnboarding={!(contacts !== undefined && (contacts.length >= onboardFollowTarget || onboardingSkipped || (!!pubkey && getOnboarded(pubkey))))}
            onResetOnboarding={handleResetOnboarding}
          />
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

      {/* Edit Profile modal — full EditProfileForm (merges existing metadata,
          supports banner/nip05 + banner display settings) */}
      {pubkey && (
        <Modal visible={showEditProfile} animationType="slide">
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowEditProfile(false)}>
                <Text style={styles.modalCloseText}>{'<'} Back</Text>
              </TouchableOpacity>
            </View>
            <EditProfileForm onSaved={() => setShowEditProfile(false)} />
          </View>
        </Modal>
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
  // Backup
  backupStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  backupMsg: { color: '#b3b3b3', fontSize: 13, marginBottom: 8 },
  backupSuccess: { color: '#4ade80' },
  backupError: { color: '#f87171' },
  checkpointRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#404040' },
  checkpointTime: { color: '#b3b3b3', fontSize: 13 },
  checkpointRestore: { color: '#f97316', fontSize: 13 },
  info: { color: '#b3b3b3', fontSize: 13, marginBottom: 4 },
  // Full-screen modals (edit profile, emoji editor)
  modalContainer: { flex: 1, backgroundColor: '#1f1f1f', paddingTop: 60, paddingHorizontal: 16 },
  modalHeader: { marginBottom: 16 },
  modalCloseText: { color: '#a855f7', fontSize: 16, fontWeight: '500' },
});
