/**
 * Mobile auth context — manages multiple Nostr accounts with secure keychain storage.
 *
 * Each account's nsec is stored in the OS keychain under a per-pubkey service name.
 * The account list (pubkeys + active account) is tracked in MMKV.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import * as Keychain from 'react-native-keychain';
import { nip19, getPublicKey } from 'nostr-tools';
import { NSecSigner } from '@nostrify/nostrify';
import { handleLogoutStorage, switchActiveUser } from '../lib/storageKeys';
import { clearRelayCache } from './NostrProvider';
import { clearCollapsedNotesModuleState } from '../hooks/useCollapsedNotes';
import { evictCachedProfile, clearProfileCache } from '../lib/cacheStore';
import { mobileStorage } from '../storage/MmkvStorage';

const KEYCHAIN_SERVICE_PREFIX = 'corkboards-nsec:';
const ACCOUNTS_KEY = 'corkboard:accounts'; // JSON array of pubkeys
const ACTIVE_ACCOUNT_KEY = 'corkboard:active-account'; // pubkey string
const MIGRATION_DONE_KEY = 'corkboard:keychain-migrated'; // flag to prevent re-migration

function keychainService(pubkey: string) {
  return `${KEYCHAIN_SERVICE_PREFIX}${pubkey}`;
}

/** Read stored account list from MMKV */
function getStoredAccounts(): string[] {
  try {
    const raw = mobileStorage.getSync(ACCOUNTS_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore */ }
  return [];
}

function setStoredAccounts(pubkeys: string[]) {
  mobileStorage.setSync(ACCOUNTS_KEY, JSON.stringify(pubkeys));
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

interface AuthState {
  pubkey: string | null;
  signer: NSecSigner | null;
  loading: boolean;
  accounts: string[]; // all logged-in pubkeys
}

interface AuthContextValue extends AuthState {
  loginWithNsec: (nsec: string) => Promise<void>;
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
  const pubkeyRef = useRef<string | null>(null);
  pubkeyRef.current = state.pubkey;

  // Restore session from keychain on mount
  useEffect(() => {
    (async () => {
      try {
        const accounts = getStoredAccounts();
        const activePubkey = getStoredActiveAccount();

        // Migrate from old single-account keychain if no accounts stored
        // Guard with a flag to prevent concurrent or repeated migration attempts
        const alreadyMigrated = mobileStorage.getSync(MIGRATION_DONE_KEY) === 'true';
        if (accounts.length === 0 && !alreadyMigrated) {
          try {
            mobileStorage.setSync(MIGRATION_DONE_KEY, 'true');
            const oldCreds = await Keychain.getGenericPassword({ service: 'corkboards-nsec' });
            if (oldCreds && oldCreds.password) {
              const decoded = nip19.decode(oldCreds.password);
              if (decoded.type === 'nsec') {
                const pk = getPublicKey(decoded.data);
                // Store under new per-pubkey service
                await Keychain.setGenericPassword('nsec', oldCreds.password, {
                  service: keychainService(pk),
                });
                // Clean up old entry
                await Keychain.resetGenericPassword({ service: 'corkboards-nsec' });
                // Register account
                setStoredAccounts([pk]);
                setStoredActiveAccount(pk);
                const signer = new NSecSigner(decoded.data);
                setState({ pubkey: pk, signer, loading: false, accounts: [pk] });
                return;
              }
            }
          } catch {
            // No old keychain entry — normal for fresh installs
          }
          setState(prev => ({ ...prev, loading: false }));
          return;
        }

        // Pick active account (or first available)
        const targetPubkey = activePubkey && accounts.includes(activePubkey)
          ? activePubkey
          : accounts[0];

        const creds = await Keychain.getGenericPassword({ service: keychainService(targetPubkey) });
        if (creds && creds.password) {
          const decoded = nip19.decode(creds.password);
          if (decoded.type === 'nsec') {
            const signer = new NSecSigner(decoded.data);
            setStoredActiveAccount(targetPubkey);
            setState({ pubkey: targetPubkey, signer, loading: false, accounts });
            return;
          }
        }

        // Keychain entry missing — remove stale account
        const cleaned = accounts.filter(a => a !== targetPubkey);
        setStoredAccounts(cleaned);
        setState(prev => ({ ...prev, loading: false, accounts: cleaned }));
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

    // Persist in OS keychain under per-pubkey service
    await Keychain.setGenericPassword('nsec', nsec, { service: keychainService(pubkey) });

    // Add to accounts list if not already present
    const accounts = getStoredAccounts();
    if (!accounts.includes(pubkey)) {
      accounts.push(pubkey);
      setStoredAccounts(accounts);
    }

    // Switch active user storage
    const oldPubkey = pubkeyRef.current;
    if (oldPubkey && oldPubkey !== pubkey) {
      switchActiveUser(oldPubkey, pubkey);
    }
    setStoredActiveAccount(pubkey);

    setState({ pubkey, signer, loading: false, accounts });
  }, []);

  const switchAccount = useCallback(async (pubkey: string) => {
    const accounts = getStoredAccounts();
    if (!accounts.includes(pubkey)) throw new Error('Account not found');

    const creds = await Keychain.getGenericPassword({ service: keychainService(pubkey) });
    if (!creds || !creds.password) throw new Error('Keychain entry not found');

    const decoded = nip19.decode(creds.password);
    if (decoded.type !== 'nsec') throw new Error('Invalid keychain data');

    const signer = new NSecSigner(decoded.data);

    // Switch per-user storage
    const oldPubkey = pubkeyRef.current;
    if (oldPubkey && oldPubkey !== pubkey) {
      switchActiveUser(oldPubkey, pubkey);
      // Clear in-memory caches so stale data doesn't leak between users
      clearRelayCache();
      clearCollapsedNotesModuleState();
      // Evict the new user's profile so it's fetched fresh from relays
      evictCachedProfile(pubkey);
    }
    setStoredActiveAccount(pubkey);

    setState({ pubkey, signer, loading: false, accounts });
  }, []);

  const removeAccount = useCallback(async (pubkey: string) => {
    handleLogoutStorage(pubkey);
    await Keychain.resetGenericPassword({ service: keychainService(pubkey) });

    // Clear in-memory caches (they're from the departing user)
    clearRelayCache();
    clearCollapsedNotesModuleState();

    const accounts = getStoredAccounts().filter(a => a !== pubkey);
    setStoredAccounts(accounts);

    // If removing the active account, switch to another or clear
    if (pubkeyRef.current === pubkey) {
      if (accounts.length > 0) {
        // Switch to next account
        const nextPubkey = accounts[0];
        try {
          const creds = await Keychain.getGenericPassword({ service: keychainService(nextPubkey) });
          if (creds && creds.password) {
            const decoded = nip19.decode(creds.password);
            if (decoded.type === 'nsec') {
              const signer = new NSecSigner(decoded.data);
              setStoredActiveAccount(nextPubkey);
              // Evict the new user's profile so it's fetched fresh
              evictCachedProfile(nextPubkey);
              setState({ pubkey: nextPubkey, signer, loading: false, accounts });
              return;
            }
          }
        } catch { /* fall through to full logout */ }
      }
      // No accounts left or switch failed
      setStoredActiveAccount(null);
      setState({ pubkey: null, signer: null, loading: false, accounts: [] });
    } else {
      setState(prev => ({ ...prev, accounts }));
    }
  }, []);

  const logout = useCallback(async () => {
    // Remove ALL accounts
    const accounts = getStoredAccounts();
    for (const pk of accounts) {
      handleLogoutStorage(pk);
      await Keychain.resetGenericPassword({ service: keychainService(pk) });
    }
    setStoredAccounts([]);
    setStoredActiveAccount(null);
    clearRelayCache();
    clearCollapsedNotesModuleState();
    setState({ pubkey: null, signer: null, loading: false, accounts: [] });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, loginWithNsec, logout, removeAccount, switchAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
