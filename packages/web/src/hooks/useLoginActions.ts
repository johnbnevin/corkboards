/**
 * useLoginActions — all supported Nostr authentication methods in one hook.
 *
 * ## Login methods
 *
 * | Method          | Description                                              |
 * |-----------------|----------------------------------------------------------|
 * | `nsec()`        | Private key login. Stores in OS keychain on Tauri desktop. |
 * | `bunker()`      | NIP-46 remote signer via bunker:// URI (e.g. nsecBunker). |
 * | `extension()`   | Browser extension (NIP-07, e.g. Soapbox Signer).        |
 * | `nostrconnect()`| QR-code flow: generates a nostrconnect:// URI and waits for signer. |
 * | `amberConnect()`| Deep-link flow for Amber signer on Android (NIP-46).    |
 *
 * ## Logout / data wipe
 * - `logout(pubkey)` — removes the session for one account; leaves IDB data intact.
 * - `nuclearWipe()` — destroys EVERYTHING: logins, localStorage, sessionStorage,
 *   cookies, IndexedDB, Tauri keychain entries. Intended for "sign out and erase".
 *
 * ## Security notes
 * - nsec is never stored in localStorage. On Tauri it goes to the OS keychain;
 *   on web it stays in @nostrify/react's in-memory login state only.
 * - nostrconnect and amberConnect generate a fresh ephemeral key pair per session.
 * - The nostrconnect relays are `NOSTRCONNECT_RELAYS` from @/lib/relayConstants.
 */
import { useNostr } from '@nostrify/react';
import { NLogin, useNostrLogin } from '@nostrify/react/login';
import { NConnectSigner, NRelay1, NSecSigner } from '@nostrify/nostrify';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { idbSetSync, idbClear } from '@/lib/idb';
import { clearNotesCache } from '@/lib/notesCache';
import { clearCache as clearProfileCacheDb, clearMemCache as clearProfileMemCache } from '@/lib/cacheStore';
import { clearCollapsedNotesModuleState } from '@/hooks/useCollapsedNotes';
import { clearNoteCardCache } from '@/components/NoteCard';
import { isTauri, keychainStore, keychainDelete } from '@/lib/tauri';
import { NOSTRCONNECT_RELAYS } from '@/lib/relayConstants';

const BACKUP_CHECKED_KEY = 'corkboard:backup-checked';

export function useLoginActions() {
  const { nostr } = useNostr();
  const { logins, addLogin, removeLogin } = useNostrLogin();

  return {
    async nsec(nsec: string, opts?: { isNewUser?: boolean }): Promise<void> {
      const login = NLogin.fromNsec(nsec);
      addLogin(login);
      const decoded = nip19.decode(nsec);
      if (decoded.type === 'nsec') {
        const pubkey = getPublicKey(decoded.data);
        // Only skip backup check for brand-new accounts (no backup exists to restore)
        if (opts?.isNewUser) {
          idbSetSync(`${BACKUP_CHECKED_KEY}:${pubkey}`, 'true');
        }
        // On Tauri desktop, store nsec in OS keychain for secure persistence
        if (isTauri) {
          const stored = await keychainStore(`nsec:${pubkey}`, nsec);
          if (!stored) {
            console.error('[login] Failed to store nsec in OS keychain — key may not persist across restarts');
          }
        }
      }
    },

    async bunker(uri: string): Promise<void> {
      const login = await NLogin.fromBunker(uri, nostr);
      addLogin(login);
    },

    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addLogin(login);
    },

    // Generate nostrconnect URI and wait for signer response (QR code flow)
    // Returns the URI immediately via onUri callback, then resolves when signer responds
    async nostrconnect(signal: AbortSignal, onUri: (uri: string) => void): Promise<void> {
      const sk = generateSecretKey();
      const clientPubkey = getPublicKey(sk);
      const clientNsec = nip19.nsecEncode(sk);
      const clientSigner = new NSecSigner(sk);
      const secretBytes = crypto.getRandomValues(new Uint8Array(16));
      const secret = Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const connectRelays = NOSTRCONNECT_RELAYS;

      const params = new URLSearchParams();
      for (const r of connectRelays) params.append('relay', r);
      params.append('secret', secret);
      params.append('name', 'corkboards.me');

      const uri = `nostrconnect://${clientPubkey}?${params.toString()}`;
      onUri(uri);

      // Open direct relay connections (not through NPool, which uses backoff:false)
      const relays = connectRelays.map(url => new NRelay1(url, { idleTimeout: false }));
      const subs = relays.map(relay =>
        relay.req(
          [{ kinds: [24133], '#p': [clientPubkey] }],
          { signal },
        )
      );

      // Race all relays for the signer's connect response
      const result = await new Promise<{ bunkerPubkey: string; relayIndex: number }>((resolve, reject) => {
        let resolved = false;
        signal.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

        for (let ri = 0; ri < subs.length; ri++) {
          const sub = subs[ri];
          (async () => {
            try {
              for await (const msg of sub) {
                if (resolved) return;
                if (msg[0] === 'CLOSED') continue;
                if (msg[0] === 'EVENT') {
                  const event = msg[2];
                  try {
                    const decrypted = await clientSigner.nip44!.decrypt(event.pubkey, event.content);
                    const response = JSON.parse(decrypted);
                    if (typeof response === 'object' && response !== null && response.result === secret) {
                      resolved = true;
                      resolve({ bunkerPubkey: event.pubkey, relayIndex: ri });
                      return;
                    }
                  } catch { /* not our response */ }
                }
              }
            } catch { /* subscription closed or errored */ }
          })();
        }
      });

      // Use the relay that got the response for the NConnectSigner
      const signer = new NConnectSigner({
        relay: relays[result.relayIndex],
        pubkey: result.bunkerPubkey,
        signer: clientSigner,
        timeout: 60_000,
      });
      const userPubkey = await signer.getPublicKey();

      const login = new NLogin('bunker', userPubkey, {
        bunkerPubkey: result.bunkerPubkey,
        clientNsec,
        relays: connectRelays,
      });
      addLogin(login);
    },

    // Login via nostrconnect:// deep link (Amber on Android)
    async amberConnect(signal?: AbortSignal): Promise<void> {
      const sk = generateSecretKey();
      const clientPubkey = getPublicKey(sk);
      const clientNsec = nip19.nsecEncode(sk);
      const clientSigner = new NSecSigner(sk);
      const secretBytes2 = crypto.getRandomValues(new Uint8Array(16));
      const secret = Array.from(secretBytes2).map(b => b.toString(16).padStart(2, '0')).join('');
      const connectRelays = NOSTRCONNECT_RELAYS;

      // Build nostrconnect:// URI per NIP-46
      const params = new URLSearchParams();
      for (const r of connectRelays) params.append('relay', r);
      params.append('secret', secret);
      params.append('name', 'corkboards.me');
      params.append('url', 'https://corkboards.me');
      params.append('perms', 'get_public_key,sign_event,nip44_encrypt,nip44_decrypt');

      // Open direct relay connections (not through NPool)
      const relays = connectRelays.map(url => new NRelay1(url, { idleTimeout: false }));
      const subs = relays.map(relay =>
        relay.req(
          [{ kinds: [24133], '#p': [clientPubkey] }],
          { signal },
        )
      );

      // Listen for signer's connect response — race all relays
      const responsePromise = new Promise<string>((resolve, reject) => {
        let resolved = false;
        signal?.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

        for (const sub of subs) {
          (async () => {
            try {
              for await (const msg of sub) {
                if (resolved) return;
                if (msg[0] === 'EVENT') {
                  const event = msg[2];
                  try {
                    const decrypted = await clientSigner.nip44!.decrypt(event.pubkey, event.content);
                    const response = JSON.parse(decrypted);
                    if (typeof response === 'object' && response !== null && response.result === secret) {
                      resolved = true;
                      resolve(event.pubkey);
                      return;
                    }
                  } catch { /* not our response */ }
                }
              }
            } catch { /* subscription closed or errored */ }
          })();
        }
      });

      // Trigger Amber — use Intent URI on Android, link click on desktop
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) {
        const fallback = encodeURIComponent('https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner');
        window.location.href = `intent://${clientPubkey}?${params.toString()}#Intent;scheme=nostrconnect;package=com.greenart7c3.nostrsigner;S.browser_fallback_url=${fallback};end`;
      } else {
        const a = document.createElement('a');
        a.href = `nostrconnect://${clientPubkey}?${params.toString()}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      // Wait for signer's response
      const bunkerPubkey = await responsePromise;

      // Get the user's actual pubkey via NIP-46
      const signer = new NConnectSigner({
        relay: relays[0],
        pubkey: bunkerPubkey,
        signer: clientSigner,
        timeout: 60_000,
      });
      const userPubkey = await signer.getPublicKey();

      // Store as a standard bunker login
      const login = new NLogin('bunker', userPubkey, {
        bunkerPubkey,
        clientNsec,
        relays: connectRelays,
      });
      addLogin(login);
    },

    /** Nuclear wipe — destroys ALL local data. Nothing survives. */
    async nuclearWipe(onProgress?: (step: string) => void): Promise<void> {
      const log = onProgress || (() => {});

      log('Removing login credentials...');
      for (const l of [...logins]) {
        if (isTauri) await keychainDelete(`nsec:${l.pubkey}`);
        removeLogin(l.id);
      }

      log('Clearing localStorage...');
      localStorage.clear();
      log('Clearing sessionStorage...');
      sessionStorage.clear();

      log('Expiring cookies...');
      const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie.split(';').forEach(c => {
        const name = c.trim().split('=')[0];
        document.cookie = `${name}=;${expired};path=/`;
        document.cookie = `${name}=;${expired};path=${location.pathname}`;
        if (location.hostname !== 'localhost') {
          document.cookie = `${name}=;${expired};path=/;domain=${location.hostname}`;
          document.cookie = `${name}=;${expired};path=/;domain=.${location.hostname}`;
        }
      });

      log('Clearing in-memory caches...');
      clearProfileMemCache();
      clearCollapsedNotesModuleState();
      clearNoteCardCache();

      document.querySelectorAll<HTMLInputElement>('input').forEach(el => { el.value = ''; });
      document.querySelectorAll<HTMLFormElement>('form').forEach(f => f.reset());

      log('Closing IndexedDB connections...');
      await idbClear().catch(() => {});

      log('Clearing notes cache database...');
      await clearNotesCache().catch(() => {});

      log('Clearing profile cache database...');
      await clearProfileCacheDb().catch(() => {});

      const deleteAllDbs = async () => {
        const dbs = await indexedDB.databases();
        const dbNames = dbs.map(db => db.name).filter(Boolean);
        log(`Deleting ${dbNames.length} IndexedDB databases: ${dbNames.join(', ')}...`);
        await Promise.all(
          dbs.map(db => db.name ? new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(db.name!);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }) : Promise.resolve())
        );
      };
      await deleteAllDbs().catch(() => {});

      log('Unregistering service workers...');
      await navigator.serviceWorker.getRegistrations()
        .then(regs => {
          if (regs.length > 0) log(`Found ${regs.length} service worker(s).`);
          return Promise.all(regs.map(r => r.unregister()));
        })
        .catch(() => {});

      log('Clearing Cache API storage...');
      await caches.keys()
        .then(async keys => {
          if (keys.length > 0) log(`Deleting ${keys.length} cache(s): ${keys.join(', ')}...`);
          for (const k of keys) {
            await caches.delete(k);
            log(`  Deleted cache: ${k}`);
          }
        })
        .catch(() => {});

      log('Final cleanup sweep...');
      localStorage.clear();
      sessionStorage.clear();
      await deleteAllDbs().catch(() => {});
      log('All local data wiped.');
    },

    /** Full logout: nuclear wipe then hard reload. */
    async logout(): Promise<void> {
      await this.nuclearWipe();
      // HttpOnly cookies, browser autofill, and some Cache API entries cannot be
      // cleared by JavaScript. Warn users to manually clear browser data.
      try {
        alert('Signed out. For maximum security, clear your browser data (cookies, cache, autofill) manually via browser settings.');
      } catch { /* popup blocked */ }
      window.location.replace('/');
    },
  };
}
