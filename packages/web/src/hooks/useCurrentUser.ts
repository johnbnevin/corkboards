import { type NLoginType, NUser, useNostrLogin } from '@nostrify/react/login';
import { useNostr } from '@nostrify/react';
import type { NPool } from '@nostrify/nostrify';
import { useMemo } from 'react';

import { useAuthor } from './useAuthor.ts';
import { isTauri } from '@/lib/tauri';
import { createTauriNsecSigner } from '@/lib/tauriSigner';
import { createWebNsecSigner } from '@/lib/webNsecSigner';
import { createLazyBunkerUser } from '@/lib/bunkerUser';
import { peekSecret, bunkerClientSecretId } from '@/lib/webKeyStore';

/**
 * Module-scoped NUser cache.
 *
 * Without this, every call to useCurrentUser (10+ consumers across hooks)
 * produced fresh NUser instances per render via NUser.from*Login(). For
 * bunker (NIP-46) logins that meant each consumer opened its own
 * NConnectSigner with its own pool.group(...) → its own WebSocket to the
 * Amber relays. The result: every render churned through user-identity
 * resets, every downstream effect with `[user]` re-fired, the splash log
 * filled with duplicates, and the bunker signer crawled because Amber was
 * juggling N parallel client connections instead of one.
 *
 * Caching by `${type}:${pubkey}:${id}` is safe because each NLogin is
 * already keyed by id; if the user logs out and back in with a new login,
 * a new id (and new cache entry) is produced. Cleared on full logout via
 * the size cap.
 */
const _userCache = new Map<string, NUser>();
const USER_CACHE_MAX = 32;

function buildUser(login: NLoginType, nostr: NPool): NUser {
  switch (login.type) {
    case 'nsec': {
      // On Tauri desktop, sign + encrypt in Rust so the nsec never enters JS
      // (it lives only in the OS keychain). Duck-type an NUser — the app only
      // consumes `.method`/`.pubkey`/`.signer`.
      //
      // ...but ONLY when the keychain actually holds the key. useLoginActions
      // deliberately leaves `data.nsec` populated when `keychainStore` fails, so
      // a keychain that is locked, absent (headless/minimal Linux desktops have
      // no Secret Service) or erroring doesn't lock the user out. Returning the
      // keychain signer unconditionally, as this did, threw that lifeline away:
      // the Rust signer looked up a key that had never been stored and every
      // signature failed, on exactly the machines where the fallback was written
      // to help. A non-empty data.nsec is the signal that the fallback is live.
      const tauriNsecData = (login.data ?? null) as { nsec?: string } | null;
      if (isTauri && !tauriNsecData?.nsec) {
        return {
          method: 'nsec',
          pubkey: login.pubkey,
          signer: createTauriNsecSigner(login.pubkey),
        } as unknown as NUser;
      }
      if (isTauri) {
        // Keychain write had failed — sign with the key still held in the login.
        return NUser.fromNsecLogin(login);
      }
      // Plain web: the persisted login carries a BLANKED data.nsec — the real
      // key lives AES-GCM-encrypted in IndexedDB (lib/webKeyStore). Duck-type
      // an NUser whose signer decrypts lazily. A non-empty data.nsec means the
      // encrypted store was unavailable at login time and we fell back to the
      // legacy in-login key (handled by NUser.fromNsecLogin below).
      const nsecData = (login.data ?? null) as { nsec?: string } | null;
      if (!nsecData?.nsec) {
        return {
          method: 'nsec',
          pubkey: login.pubkey,
          signer: createWebNsecSigner(login.pubkey),
        } as unknown as NUser;
      }
      return NUser.fromNsecLogin(login);
    }
    case 'bunker': {
      // The NIP-46 client key is kept AES-GCM-encrypted in IndexedDB
      // (lib/webKeyStore), not as plaintext in localStorage, so the persisted
      // login carries a blanked `clientNsec`. webKeyStore.prepareLoginStorage
      // warms the session cache before React mounts (main.tsx awaits it), which
      // is what lets this synchronous builder read it back.
      //
      // A non-empty clientNsec means the encrypted store was unavailable at
      // login time and we fell back to legacy in-login storage — use it as-is,
      // exactly like the nsec path, so a storage failure never locks anyone out.
      const bunkerData = login.data as { clientNsec?: string } | undefined;
      if (!bunkerData?.clientNsec) {
        const clientNsec = peekSecret(bunkerClientSecretId(login.pubkey));
        if (!clientNsec) {
          // Cache not warm yet — main.tsx only bounded-waits for
          // prepareLoginStorage, and on a slow IndexedDB (WebKitGTK) the app
          // mounts first. Throwing here skipped every bunker login and booted
          // a validly-logged-in user to the login screen; hand back a lazy
          // user that resolves the key on first signer use instead.
          return createLazyBunkerUser(login, nostr);
        }
        return NUser.fromBunkerLogin(
          { ...login, data: { ...login.data, clientNsec } } as typeof login,
          nostr,
        );
      }
      return NUser.fromBunkerLogin(login, nostr);
    }
    case 'extension':
      return NUser.fromExtensionLogin(login);
    default:
      throw new Error(`Unsupported login type: ${(login as { type: string }).type}`);
  }
}

export function getOrCreateUser(login: NLoginType, nostr: NPool): NUser {
  const key = `${login.type}:${login.pubkey}:${login.id ?? ''}`;
  const cached = _userCache.get(key);
  if (cached) return cached;
  const user = buildUser(login, nostr);
  if (_userCache.size >= USER_CACHE_MAX) {
    // Evict the oldest entry — Map iteration order is insertion order.
    const first = _userCache.keys().next().value;
    if (first !== undefined) _userCache.delete(first);
  }
  _userCache.set(key, user);
  return user;
}

export function useCurrentUser(fetchProfile = true) {
  const { nostr } = useNostr();
  const { logins } = useNostrLogin();

  const users = useMemo(() => {
    const users: NUser[] = [];
    for (const login of logins) {
      try {
        users.push(getOrCreateUser(login, nostr));
      } catch (error) {
        console.warn('Skipped invalid login', login.id, error);
      }
    }
    return users;
  }, [logins, nostr]);

  const user = users[0] as NUser | undefined;
  const author = useAuthor(user?.pubkey, fetchProfile);

  return {
    user,
    users,
    ...author.data,
  };
}
