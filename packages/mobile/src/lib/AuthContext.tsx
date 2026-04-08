/**
 * Mobile auth context — manages nsec login with secure keychain storage.
 *
 * Stores the nsec in react-native-keychain (OS-level secure enclave)
 * and derives the pubkey + NSecSigner for signing events.
 */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as Keychain from 'react-native-keychain';
import { nip19, getPublicKey } from 'nostr-tools';
import { NSecSigner } from '@nostrify/nostrify';
import { handleLogoutStorage } from '../lib/storageKeys';
import { clearRelayCache } from './NostrProvider';
import { clearCollapsedNotesModuleState } from '../hooks/useCollapsedNotes';

const KEYCHAIN_SERVICE = 'corkboards-nsec';

interface AuthState {
  pubkey: string | null;
  signer: NSecSigner | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  loginWithNsec: (nsec: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ pubkey: null, signer: null, loading: true });

  // Restore session from keychain on mount
  useEffect(() => {
    (async () => {
      try {
        const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
        if (creds && creds.password) {
          const decoded = nip19.decode(creds.password);
          if (decoded.type === 'nsec') {
            const sk = decoded.data;
            const pubkey = getPublicKey(sk);
            const signer = new NSecSigner(sk);
            setState({ pubkey, signer, loading: false });
            return;
          }
        }
      } catch (e) {
        // Keychain may have no entry yet — expected on first launch
        if (e instanceof Error && !e.message.toLowerCase().includes('no entry') && !e.message.toLowerCase().includes('not found')) {
          console.warn('[AuthContext] Unexpected keychain error:', e.message);
        }
      }
      setState(prev => ({ ...prev, loading: false }));
    })();
  }, []);

  const loginWithNsec = useCallback(async (nsec: string) => {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');

    const sk = decoded.data;
    const pubkey = getPublicKey(sk);
    const signer = new NSecSigner(sk);

    // Persist in OS keychain
    await Keychain.setGenericPassword('nsec', nsec, { service: KEYCHAIN_SERVICE });

    setState({ pubkey, signer, loading: false });
  }, []);

  const logout = useCallback(async () => {
    if (state.pubkey) {
      handleLogoutStorage(state.pubkey);
    }
    clearRelayCache();
    clearCollapsedNotesModuleState();
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    setState({ pubkey: null, signer: null, loading: false });
  }, [state.pubkey]);

  return (
    <AuthContext.Provider value={{ ...state, loginWithNsec, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
