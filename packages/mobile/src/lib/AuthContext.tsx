/**
 * Mobile auth context — manages multiple Nostr accounts with secure keychain storage.
 *
 * Supports two account types:
 * - nsec: key stored in OS keychain; session is an NSecSigner
 * - bunker: NIP-46 remote signer (Amber, nsec.app); clientNsec in keychain,
 *   bunker metadata in MMKV; session is an NConnectSigner
 *
 * The account list (pubkeys + active account) is tracked in MMKV.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Keychain from 'react-native-keychain';
import { nip19, getPublicKey } from 'nostr-tools';
import { NSecSigner, NConnectSigner, NRelay1 } from '@nostrify/nostrify';
import { handleLogoutStorage, switchActiveUser } from '../lib/storageKeys';
import { flushBackupBeforeSwitch } from '../lib/backupFlush';
import { clearRelayCache, createRelay, registerAuthRelay } from './NostrProvider';
import { isSecureRelay } from '@core/nostrUtils';
import { clearCollapsedNotesModuleState } from '../hooks/useCollapsedNotes';
import { clearBookmarksModuleState } from '../hooks/useBookmarks';
import { clearNotesCache } from './notesCache';
import { evictCachedProfile, clearProfileCache } from '../lib/cacheStore';
import { mobileStorage } from '../storage/MmkvStorage';
import { bumpSessionEpoch } from '../hooks/useSessionAbort';

const KEYCHAIN_SERVICE_PREFIX = 'corkboards-nsec:';
const KEYCHAIN_CLIENTNSEC_PREFIX = 'corkboards-clientnsec:';
/** Legacy plaintext account list — removed on first launch after the keychain-enumeration switch. */
const ACCOUNTS_KEY = 'corkboard:accounts';
const ACTIVE_ACCOUNT_KEY = 'corkboard:active-account';
const MIGRATION_DONE_KEY = 'corkboard:keychain-migrated';
const ENUM_MIGRATION_FLAG = '__accounts_migrated_to_encrypted__';

/**
 * Storage options for every secret-key entry this module writes.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` matters for two independent reasons:
 *
 *   - THIS_DEVICE_ONLY excludes the entry from iCloud Keychain sync and from
 *     encrypted iTunes/Finder and Android cloud backups. Without it the user's
 *     nsec leaves the device and lands on a third party's servers — which is
 *     exactly what "private keys never touch a server" forbids, and it happens
 *     silently, with no UI anywhere in the app that would reveal it.
 *   - WHEN_UNLOCKED (rather than AFTER_FIRST_UNLOCK) keeps the key unreadable
 *     while the screen is locked, so a lock-screen-bypass or a background
 *     process on a locked device can't pull it.
 *
 * The MMKV *database* encryption key already used a THIS_DEVICE_ONLY flag (see
 * storage/MmkvStorage.ts); the nsecs it exists to protect did not. It uses
 * AFTER_FIRST_UNLOCK deliberately — it must be readable during background
 * launch — whereas signing only ever happens with the app in the foreground,
 * so the stricter class is free here.
 */
const SECRET_STORAGE_OPTIONS = {
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} as const;

function keychainService(pubkey: string) {
  return `${KEYCHAIN_SERVICE_PREFIX}${pubkey}`;
}

function clientNsecService(pubkey: string) {
  return `${KEYCHAIN_CLIENTNSEC_PREFIX}${pubkey}`;
}

function getBunkerData(pubkey: string): { bunkerPubkey: string; relays: string[] } | null {
  try {
    const raw = mobileStorage.getSync(`corkboard:bunker:${pubkey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { bunkerPubkey?: unknown; relays?: unknown };
    if (typeof parsed?.bunkerPubkey !== 'string') return null;
    // Re-validate on read, not just on write: this record is persisted state
    // that a later app version (or a restored backup) may have written under
    // different rules, and every entry becomes a WebSocket we dial.
    const relays = Array.isArray(parsed.relays) ? parsed.relays.filter(isSecureRelay) : [];
    if (relays.length === 0) return null;
    return { bunkerPubkey: parsed.bunkerPubkey, relays };
  } catch { /* ignore */ }
  return null;
}

/**
 * Open the signalling relay for a NIP-46 bunker session.
 *
 * Goes through `createRelay` rather than `new NRelay1` so the connection gets
 * the same rate limiting, failure backoff and — critically — the NIP-42 AUTH
 * handler every other relay in the app has. A raw NRelay1 has no `auth`
 * callback at all, so a bunker relay that gates reads behind AUTH would just
 * return nothing and the login would hang with no error. `registerAuthRelay`
 * marks it as a deliberate connection so the gated handler answers its
 * challenge. Parity with web's useLoginActions, which uses createRelayDirect.
 */
function openBunkerRelay(url: string): NRelay1 {
  registerAuthRelay(url);
  return createRelay(url, { backoff: false });
}

function setBunkerData(pubkey: string, data: { bunkerPubkey: string; relays: string[] }) {
  mobileStorage.setSync(`corkboard:bunker:${pubkey}`, JSON.stringify(data));
}

function getAccountType(pubkey: string): 'nsec' | 'bunker' {
  return (mobileStorage.getSync(`corkboard:account-type:${pubkey}`) as 'nsec' | 'bunker') ?? 'nsec';
}

function setAccountType(pubkey: string, type: 'nsec' | 'bunker') {
  mobileStorage.setSync(`corkboard:account-type:${pubkey}`, type);
}

function removeBunkerData(pubkey: string) {
  mobileStorage.removeSync(`corkboard:bunker:${pubkey}`);
  mobileStorage.removeSync(`corkboard:account-type:${pubkey}`);
}

/**
 * Erase every secret this module can hold for a pubkey.
 *
 * Both keychain services are reset UNCONDITIONALLY rather than branching on the
 * MMKV account-type record. That record is ordinary app storage: a restored
 * backup, a partial wipe, or a failed write can leave it missing or wrong, and
 * when it did, the branch it drove removed the wrong entry — a bunker account
 * whose type record had gone read back as 'nsec', so its `corkboards-clientnsec:`
 * key survived "remove account" and the identity kept reappearing in the account
 * list. Resetting a service that holds nothing is free; leaving a private key on
 * the device after the user asked for it to be gone is not.
 */
async function purgeAccountSecrets(pubkey: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: keychainService(pubkey) }).catch(() => {});
  await Keychain.resetGenericPassword({ service: clientNsecService(pubkey) }).catch(() => {});
  removeBunkerData(pubkey);
}

/**
 * Enumerate accounts from the OS keychain.
 *
 * Cypherpunk: the pubkey list is no longer persisted in MMKV. It's derived on
 * demand from keychain entries whose service names use known prefixes. This
 * means even with full filesystem access (no keychain), an attacker can't see
 * which Nostr identities live on the device — they're locked behind the OS
 * keychain's hardware-backed isolation.
 *
 * Both nsec accounts (`corkboards-nsec:{pk}`) and bunker accounts
 * (`corkboards-clientnsec:{pk}`) are included. Returned list is deduplicated.
 */
async function getStoredAccounts(): Promise<string[]> {
  try {
    const services = await Keychain.getAllGenericPasswordServices();
    const pubkeys = new Set<string>();
    for (const s of services) {
      if (s.startsWith(KEYCHAIN_SERVICE_PREFIX)) {
        const pk = s.slice(KEYCHAIN_SERVICE_PREFIX.length);
        if (pk) pubkeys.add(pk);
      } else if (s.startsWith(KEYCHAIN_CLIENTNSEC_PREFIX)) {
        const pk = s.slice(KEYCHAIN_CLIENTNSEC_PREFIX.length);
        if (pk) pubkeys.add(pk);
      }
    }
    return [...pubkeys];
  } catch (e) {
    console.warn('[AuthContext] keychain enumeration failed:', e);
    return [];
  }
}

function getStoredActiveAccount(): string | null {
  return mobileStorage.getSync(ACTIVE_ACCOUNT_KEY) ?? null;
}

function setStoredActiveAccount(pubkey: string | null) {
  if (pubkey) {
    mobileStorage.setSync(ACTIVE_ACCOUNT_KEY, pubkey);
  } else {
    mobileStorage.removeSync(ACTIVE_ACCOUNT_KEY);
  }
}

async function buildSignerForAccount(pubkey: string): Promise<NSecSigner | NConnectSigner | null> {
  const type = getAccountType(pubkey);

  if (type === 'bunker') {
    const creds = await Keychain.getGenericPassword({ service: clientNsecService(pubkey) });
    const bunker = getBunkerData(pubkey);
    if (!creds || !bunker) return null;
    try {
      const decoded = nip19.decode(creds.password);
      if (decoded.type !== 'nsec') return null;
      const clientSk = decoded.data;
      const clientSignerInstance = new NSecSigner(clientSk);
      const relay = openBunkerRelay(bunker.relays[0]);
      return new NConnectSigner({
        relay,
        pubkey: bunker.bunkerPubkey,
        signer: clientSignerInstance,
        timeout: 60_000,
      });
    } catch { return null; }
  }

  // nsec account
  const creds = await Keychain.getGenericPassword({ service: keychainService(pubkey) });
  if (!creds) return null;
  try {
    const decoded = nip19.decode(creds.password);
    if (decoded.type !== 'nsec') return null;
    return new NSecSigner(decoded.data);
  } catch { return null; }
}

interface AuthState {
  pubkey: string | null;
  signer: NSecSigner | NConnectSigner | null;
  loading: boolean;
  accounts: string[];
}

interface AuthContextValue extends AuthState {
  loginWithNsec: (nsec: string) => Promise<void>;
  loginWithBunker: (bunkerPubkey: string, clientNsec: string, relays: string[], userPubkey: string) => Promise<void>;
  logout: () => Promise<void>;
  removeAccount: (pubkey: string) => Promise<void>;
  switchAccount: (pubkey: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    pubkey: null,
    signer: null,
    loading: true,
    accounts: [],
  });
  // Keep a ref to the active pubkey so long-lived async callbacks (logout,
  // backup-restore) see the latest value without re-binding closures.
  // Updated in a useEffect (post-commit) instead of during render to satisfy
  // the v7 refs rule and align with React 19 semantics.
  const pubkeyRef = useRef<string | null>(null);
  useEffect(() => { pubkeyRef.current = state.pubkey; }, [state.pubkey]);

  // The react-query cache is shared process-wide and is keyed by pubkey only in
  // some places (['contacts', pubkey]) and not at all in others (['mobile-feed',
  // …], profile and engagement queries). After an account swap those entries are
  // still "fresh", so the incoming account renders the departing account's feed,
  // follows and notifications until each query happens to refetch. Dropping the
  // cache on switch/logout is the only way to guarantee no cross-account bleed.
  const queryClient = useQueryClient();

  // Restore session from keychain on mount
  useEffect(() => {
    (async () => {
      try {
        // One-time scrub of the legacy plaintext account-list MMKV key.
        // The list is now derived from keychain enumeration; the MMKV copy is
        // redundant and would needlessly expose the pubkey set if encryption
        // were ever bypassed.
        if (mobileStorage.getSync(ENUM_MIGRATION_FLAG) !== '1') {
          mobileStorage.removeSync(ACCOUNTS_KEY);
          mobileStorage.setSync(ENUM_MIGRATION_FLAG, '1');
        }

        let accounts = await getStoredAccounts();
        const activePubkey = getStoredActiveAccount();

        // Migrate from old single-account keychain if no accounts stored
        const alreadyMigrated = mobileStorage.getSync(MIGRATION_DONE_KEY) === 'true';
        if (accounts.length === 0 && !alreadyMigrated) {
          try {
            mobileStorage.setSync(MIGRATION_DONE_KEY, 'true');
            const oldCreds = await Keychain.getGenericPassword({ service: 'corkboards-nsec' });
            if (oldCreds && oldCreds.password) {
              const decoded = nip19.decode(oldCreds.password);
              if (decoded.type === 'nsec') {
                const pk = getPublicKey(decoded.data);
                await Keychain.setGenericPassword('nsec', oldCreds.password, { service: keychainService(pk), ...SECRET_STORAGE_OPTIONS });
                await Keychain.resetGenericPassword({ service: 'corkboards-nsec' });
                setStoredActiveAccount(pk);
                setState({ pubkey: pk, signer: new NSecSigner(decoded.data), loading: false, accounts: [pk] });
                return;
              }
            }
          } catch {
            // No old keychain entry — normal for fresh installs
          }
          setState(prev => ({ ...prev, loading: false }));
          return;
        }

        const targetPubkey = activePubkey && accounts.includes(activePubkey) ? activePubkey : accounts[0];
        if (!targetPubkey) {
          setState(prev => ({ ...prev, loading: false, accounts }));
          return;
        }

        const signer = await buildSignerForAccount(targetPubkey);
        if (signer) {
          setStoredActiveAccount(targetPubkey);
          setState({ pubkey: targetPubkey, signer, loading: false, accounts });
        } else {
          // Stale entry — drop the keychain residue and re-enumerate.
          await Keychain.resetGenericPassword({ service: keychainService(targetPubkey) }).catch(() => {});
          await Keychain.resetGenericPassword({ service: clientNsecService(targetPubkey) }).catch(() => {});
          accounts = await getStoredAccounts();
          setState(prev => ({ ...prev, loading: false, accounts }));
        }
      } catch (e) {
        if (e instanceof Error && !e.message.toLowerCase().includes('no entry') && !e.message.toLowerCase().includes('not found')) {
          console.warn('[AuthContext] Unexpected keychain error:', e.message);
        }
        setState(prev => ({ ...prev, loading: false }));
      }
    })();
  }, []);

  const loginWithNsec = useCallback(async (nsec: string) => {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');

    const sk = decoded.data;
    const pubkey = getPublicKey(sk);
    const signer = new NSecSigner(sk);

    await Keychain.setGenericPassword('nsec', nsec, { service: keychainService(pubkey), ...SECRET_STORAGE_OPTIONS });
    setAccountType(pubkey, 'nsec');

    // Enumerate *after* writing the keychain entry so the new account is
    // included without us having to maintain a parallel list.
    const accounts = await getStoredAccounts();

    const oldPubkey = pubkeyRef.current;
    if (oldPubkey && oldPubkey !== pubkey) {
      // Logging in while another account is active IS an account switch, so it
      // needs the same pending-backup flush switchAccount does. Without it, any
      // unsaved change to account A (a new corkboard, a batch of dismissals) was
      // stashed locally and then never uploaded, because `switchActiveUser`
      // below moves A's data out from under the auto-saver.
      await flushBackupBeforeSwitch();
      // Abort BEFORE any storage swap or state set, so in-flight queries
      // for the old account can't write into the new account's UI.
      bumpSessionEpoch();
      queryClient.removeQueries();
      switchActiveUser(oldPubkey, pubkey);
    }
    setStoredActiveAccount(pubkey);

    setState({ pubkey, signer, loading: false, accounts });
  }, [queryClient]);

  const loginWithBunker = useCallback(async (
    bunkerPubkey: string,
    clientNsec: string,
    relays: string[],
    userPubkey: string,
  ) => {
    // Reject a bunker whose signalling relays are all unusable before writing
    // anything: persisting them would produce an account that can never build a
    // signer, and `relays[0]` below would be undefined.
    const safeRelays = relays.filter(isSecureRelay);
    if (safeRelays.length === 0) throw new Error('Bunker supplied no usable wss:// relay');

    // Store clientNsec in keychain
    await Keychain.setGenericPassword('clientNsec', clientNsec, { service: clientNsecService(userPubkey), ...SECRET_STORAGE_OPTIONS });

    // Store bunker metadata in MMKV
    setBunkerData(userPubkey, { bunkerPubkey, relays: safeRelays });
    setAccountType(userPubkey, 'bunker');

    const accounts = await getStoredAccounts();

    const oldPubkey = pubkeyRef.current;
    if (oldPubkey && oldPubkey !== userPubkey) {
      // Same as loginWithNsec: this is an account switch, so flush the
      // departing account's pending cloud backup before its data is stashed.
      await flushBackupBeforeSwitch();
      bumpSessionEpoch();
      queryClient.removeQueries();
      switchActiveUser(oldPubkey, userPubkey);
    }
    setStoredActiveAccount(userPubkey);

    const decoded = nip19.decode(clientNsec);
    if (decoded.type !== 'nsec') throw new Error('Invalid client nsec');
    const relay = openBunkerRelay(safeRelays[0]);
    const signer = new NConnectSigner({
      relay,
      pubkey: bunkerPubkey,
      signer: new NSecSigner(decoded.data),
      timeout: 60_000,
    });

    setState({ pubkey: userPubkey, signer, loading: false, accounts });
  }, [queryClient]);

  const switchAccount = useCallback(async (pubkey: string) => {
    const accounts = await getStoredAccounts();
    if (!accounts.includes(pubkey)) throw new Error('Account not found');

    const signer = await buildSignerForAccount(pubkey);
    if (!signer) throw new Error('Could not restore signer for account');

    const oldPubkey = pubkeyRef.current;
    if (oldPubkey && oldPubkey !== pubkey) {
      // Flush the departing account's pending cloud backup before swapping
      // (parity with logout; local data is already stashed per-pubkey below).
      await flushBackupBeforeSwitch();
      // Abort first — otherwise stale subscriptions for oldPubkey may resolve
      // after setState below and write into the new account's UI.
      bumpSessionEpoch();
      queryClient.removeQueries();
      switchActiveUser(oldPubkey, pubkey);
      clearRelayCache();
      clearCollapsedNotesModuleState();
      clearBookmarksModuleState();
      evictCachedProfile(pubkey);
    }
    setStoredActiveAccount(pubkey);

    setState({ pubkey, signer, loading: false, accounts });
  }, [queryClient]);

  const removeAccount = useCallback(async (pubkey: string) => {
    // Removing the active account changes the in-flight session, so abort
    // anything pending. Removing an inactive account is harmless but cheap
    // to handle uniformly.
    if (pubkeyRef.current === pubkey) {
      bumpSessionEpoch();
      queryClient.removeQueries();
    }
    handleLogoutStorage(pubkey);

    await purgeAccountSecrets(pubkey);

    clearRelayCache();
    clearCollapsedNotesModuleState();
    clearBookmarksModuleState();

    // Re-enumerate after the keychain deletion above; the removed pubkey is
    // automatically excluded.
    const accounts = await getStoredAccounts();

    if (pubkeyRef.current === pubkey) {
      if (accounts.length > 0) {
        const nextPubkey = accounts[0];
        try {
          const nextSigner = await buildSignerForAccount(nextPubkey);
          if (nextSigner) {
            setStoredActiveAccount(nextPubkey);
            evictCachedProfile(nextPubkey);
            setState({ pubkey: nextPubkey, signer: nextSigner, loading: false, accounts });
            return;
          }
        } catch { /* fall through to full logout */ }
      }
      setStoredActiveAccount(null);
      setState({ pubkey: null, signer: null, loading: false, accounts: [] });
    } else {
      setState(prev => ({ ...prev, accounts }));
    }
  }, [queryClient]);

  const logout = useCallback(async () => {
    bumpSessionEpoch();
    queryClient.removeQueries();
    const accounts = await getStoredAccounts();
    for (const pk of accounts) {
      handleLogoutStorage(pk);
      await purgeAccountSecrets(pk);
    }
    setStoredActiveAccount(null);
    clearRelayCache();
    clearCollapsedNotesModuleState();
    clearBookmarksModuleState();
    clearProfileCache();
    // Cached note BODIES also have to go, or they linger in MMKV and surface
    // under the next account that signs in (clearNotesCache had no callers).
    await clearNotesCache().catch(() => {});
    setState({ pubkey: null, signer: null, loading: false, accounts: [] });
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ ...state, loginWithNsec, loginWithBunker, logout, removeAccount, switchAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
