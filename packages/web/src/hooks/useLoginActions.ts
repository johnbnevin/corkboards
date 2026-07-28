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
 * - The user's nsec is never persisted in plaintext. On Tauri it goes to the
 *   OS keychain (and is blanked from the login object; Rust signs). On plain
 *   web it is encrypted under a non-extractable AES-GCM CryptoKey and stored
 *   in IndexedDB (lib/webKeyStore); the login state persisted to
 *   localStorage['corkboard:login'] carries a blanked `data.nsec`, and
 *   useCurrentUser builds a signer that decrypts on demand
 *   (lib/webNsecSigner). This protects the key at rest on disk and against
 *   casual localStorage reads — but code with full JS execution in this
 *   origin (XSS) could still invoke the decrypt path, so the strict CSP
 *   (index.html) remains the primary XSS defense. A one-time startup
 *   migration (webKeyStore.prepareLoginStorage, wired in main.tsx) moves any
 *   legacy plaintext nsec out of localStorage into the encrypted store.
 * - NIP-46 bunker logins DO persist an *ephemeral client* nsec (`clientNsec`) via
 *   @nostrify/react's login store so the bunker session can reconnect after a
 *   reload. This key only authorizes the NIP-46 channel (revocable at the
 *   bunker); it is NOT the user's identity key. It is therefore lower-value but,
 *   like anything in localStorage, XSS-exfiltratable — which the strict CSP
 *   (index.html) is the primary defense against.
 * - nostrconnect and amberConnect generate a fresh ephemeral key pair per session.
 * - The nostrconnect relays are `NOSTRCONNECT_RELAYS` from @/lib/relayConstants.
 */
import { useNostr } from '@nostrify/react';
import { NLogin, useNostrLogin } from '@nostrify/react/login';
import { NConnectSigner, NSecSigner } from '@nostrify/nostrify';
import { createRelayDirect } from '@/components/NostrProvider';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { idbSetSync, idbClear, idbKeys } from '@/lib/idb';
import { IMAGE_PROXY_TEMPLATE_KEY } from '@/lib/imageProxySettings';
import { clearNotesCache } from '@/lib/notesCache';
import { clearCache as clearProfileCacheDb, clearMemCache as clearProfileMemCache } from '@/lib/cacheStore';
import { clearCollapsedNotesModuleState } from '@/hooks/useCollapsedNotes';
import { clearNoteCardCache } from '@/components/NoteCard';
import { handleLogoutStorageAsync } from '@/lib/storageKeys';
import { isTauri, keychainStore, keychainDelete, tauriLog } from '@/lib/tauri';
import {
  storeNsec, deleteNsec, wipeKeyStore,
  storeSecret, loadSecret, deleteSecret,
  AMBER_CLIENT_SECRET_ID, bunkerClientSecretId,
} from '@/lib/webKeyStore';
import { NOSTRCONNECT_RELAYS, NSEC_APP_RELAY } from '@/lib/relayConstants';

const BACKUP_CHECKED_KEY = 'corkboard:backup-checked';

/**
 * Move a bunker login's ephemeral NIP-46 client key out of the persisted login
 * object and into the encrypted key store.
 *
 * @nostrify's login store persists the whole login to
 * `localStorage['corkboard:login']`, so leaving `clientNsec` in place wrote a
 * plaintext `nsec1…` to localStorage on every bunker/nostrconnect/Amber login.
 * That key is not the identity key, but it authenticates our end of the signing
 * channel: anyone who reads it can impersonate this client to the signer and
 * ask it to sign. It now gets the same at-rest treatment as the identity key
 * (AES-GCM under a non-extractable CryptoKey in IndexedDB), and
 * useCurrentUser/webKeyStore.prepareLoginStorage read it back.
 *
 * Persist-THEN-blank, and only blank on success — a storage failure must leave
 * the working (if weaker) legacy path intact rather than locking the user out.
 * Same availability policy as the nsec and Tauri-keychain paths. (M10)
 */
async function persistBunkerClientKey(login: { pubkey: string; data?: unknown }): Promise<void> {
  const data = login.data as { clientNsec?: string } | undefined;
  if (!data || typeof data.clientNsec !== 'string' || data.clientNsec === '') return;
  const stored = await storeSecret(bunkerClientSecretId(login.pubkey), data.clientNsec);
  if (stored) data.clientNsec = '';
  else console.error('[login] Failed to encrypt NIP-46 client key — falling back to login-state persistence');
}

export function useLoginActions() {
  const { nostr } = useNostr();
  const { logins, addLogin, removeLogin } = useNostrLogin();

  return {
    async nsec(nsec: string, opts?: { isNewUser?: boolean }): Promise<void> {
      const login = NLogin.fromNsec(nsec);
      const decoded = nip19.decode(nsec);
      if (decoded.type === 'nsec') {
        const pubkey = getPublicKey(decoded.data);
        // Only skip backup check for brand-new accounts (no backup exists to restore)
        if (opts?.isNewUser) {
          idbSetSync(`${BACKUP_CHECKED_KEY}:${pubkey}`, 'true');
        }
        // On Tauri desktop, store nsec in OS keychain for secure persistence, and
        // keep it OUT of the JS-persisted login (localStorage) entirely — the
        // Rust signer (createTauriNsecSigner) reads it from the keychain by
        // pubkey, so the nsec never lives in JS memory or localStorage. Only
        // blank it once the keychain write succeeds, so a keychain failure
        // doesn't lock the user out (fall back to the in-login key).
        if (isTauri) {
          const stored = await keychainStore(`nsec:${pubkey}`, nsec);
          if (!stored) {
            console.error('[login] Failed to store nsec in OS keychain — key may not persist across restarts');
          } else if (login.data && typeof login.data === 'object') {
            (login.data as { nsec?: string }).nsec = '';
          }
        } else {
          // Plain web: encrypt the nsec under a non-extractable AES-GCM
          // CryptoKey and persist both in IndexedDB (lib/webKeyStore), then
          // blank the copy inside the login object so @nostrify's login
          // persistence (localStorage['corkboard:login']) never sees the
          // plaintext. useCurrentUser builds a lazy decrypting signer for
          // blanked logins (lib/webNsecSigner). Only blank once the encrypted
          // write succeeds, so a storage failure doesn't lock the user out
          // (fall back to the in-login key, mirroring the Tauri path).
          const stored = await storeNsec(pubkey, nsec);
          if (!stored) {
            console.error('[login] Failed to store encrypted nsec in IndexedDB — falling back to login-state persistence');
          } else if (login.data && typeof login.data === 'object') {
            (login.data as { nsec?: string }).nsec = '';
          }
        }
      }
      addLogin(login);
    },

    async bunker(uri: string): Promise<void> {
      const login = await NLogin.fromBunker(uri, nostr);
      await persistBunkerClientKey(login);
      addLogin(login);
    },

    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addLogin(login);
    },

    /**
     * Open the signalling relay sockets ahead of time.
     *
     * The QR flow cannot hand out its URI until a relay is actually carrying our
     * REQ — kind 24133 is ephemeral, so a connect response published before the
     * subscription is live is gone for good. `nostrconnect()` waits for that,
     * but the wait is bounded (a dead relay set must not hang the screen), and
     * on a slow machine three cold TCP+TLS+WebSocket handshakes can outlast the
     * bound. Then the QR appears anyway, a quick scan beats the subscription,
     * and the user has to do the whole thing twice.
     *
     * Calling this when the login screen opens moves those handshakes into the
     * seconds the user spends reading the screen and reaching for their phone,
     * so by the time they ask for the QR the sockets are already up and the
     * subscription goes out immediately. Safe to call repeatedly:
     * `createRelayDirect` caches per URL+options, and these sockets are opened
     * with `idleTimeout: false` precisely so they stay put.
     */
    prewarmConnectRelays(): void {
      for (const url of NOSTRCONNECT_RELAYS) {
        try {
          const relay = createRelayDirect(url, { backoff: false, idleTimeout: false });
          // NRelay1 connects lazily, so touching it isn't enough — a cheap REQ
          // forces the socket open. It's aborted immediately; the connection
          // stays in the cache for the real subscription.
          const ac = new AbortController();
          const sub = relay.req([{ kinds: [24133], limit: 0 }], { signal: ac.signal });
          void (async () => {
            try { for await (const _ of sub) break; } catch { /* prewarm only */ }
          })();
          setTimeout(() => ac.abort(), 2000);
        } catch { /* one relay failing to warm is not an error */ }
      }
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
      tauriLog(`[nip46] nostrconnect URI generated, relays: ${connectRelays.join(', ')}`);

      // Inner abort controller — aborted as soon as we get a valid connect response,
      // which cleanly closes all 3 relay subscriptions. Without this, abandoned
      // for-await generators fill NRelay1's buffer and block the subsequent
      // NConnectSigner.getPublicKey() response from being delivered.
      const connectAbort = new AbortController();
      signal.addEventListener('abort', () => connectAbort.abort());

      // Open direct relay connections (not through NPool, backoff:false)
      const relays = connectRelays.map(url => createRelayDirect(url, { backoff: false, idleTimeout: false }));
      const subs = relays.map(relay =>
        relay.req(
          [{ kinds: [24133], '#p': [clientPubkey] }],
          { signal: connectAbort.signal },
        )
      );
      tauriLog(`[nip46] subscriptions opened on ${connectRelays.length} relays, waiting for response...`);

      // Resolves once a relay has actually answered our REQ (EOSE, or an event).
      // See the `onUri` call below for why the QR waits on this.
      let markSubsLive: () => void = () => {};
      const subsLive = new Promise<void>((resolve) => { markSubsLive = resolve; });

      // Race all relays for the signer's connect response
      const resultPromise = new Promise<{ bunkerPubkey: string; relayIndex: number }>((resolve, reject) => {
        let resolved = false;
        connectAbort.signal.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

        for (let ri = 0; ri < subs.length; ri++) {
          const sub = subs[ri];
          const relayUrl = connectRelays[ri];
          (async () => {
            try {
              for await (const msg of sub) {
                // Any frame means this relay processed our REQ.
                markSubsLive();
                tauriLog(`[nip46] ${relayUrl}: msg[0]=${msg[0]}`);
                if (resolved) return;
                if (msg[0] === 'CLOSED') continue;
                if (msg[0] === 'EVENT') {
                  const event = msg[2];
                  tauriLog(`[nip46] EVENT kind=${event.kind} from ${event.pubkey.slice(0,8)}`);
                  try {
                    const decrypted = await clientSigner.nip44!.decrypt(event.pubkey, event.content);
                    const response = JSON.parse(decrypted);
                    // Never log the connect secret or the decrypted RPC payload —
                    // tauriLog persists to a plaintext file on desktop. Log only
                    // the match outcome.
                    const matched = typeof response === 'object' && response !== null && response.result === secret;
                    tauriLog(`[nip46] response received, secret matched=${matched}`);
                    if (matched) {
                      resolved = true;
                      connectAbort.abort(); // close all 3 subscriptions cleanly
                      resolve({ bunkerPubkey: event.pubkey, relayIndex: ri });
                      return;
                    }
                  } catch (e) {
                    tauriLog(`[nip46] decrypt error: ${e}`);
                  }
                }
              }
              tauriLog(`[nip46] ${relayUrl}: subscription ended`);
            } catch (e) {
              tauriLog(`[nip46] ${relayUrl}: subscription error: ${e}`);
            }
          })();
        }
      });
      // Attached now so a relay failure between here and the await below can't
      // surface as an unhandled rejection; the real await is a few lines down.
      resultPromise.catch(() => {});

      // Only NOW show the QR.
      //
      // kind 24133 is in the ephemeral range (20000-29999), so relays do not
      // store it. The URI used to be handed out before these subscriptions
      // existed, which left a window — three TCP+TLS+WS handshakes wide, and
      // wider still on a cold DNS cache or a slow webview — where a user who
      // scanned promptly had their signer publish the connect response into
      // relays that were not yet carrying our REQ. Nothing stored it, nothing
      // replayed it, and the flow sat on "waiting for signer" until the user
      // gave up and started again. The second attempt then worked, because the
      // sockets were warm. That is the "I have to do the QR login twice" bug.
      //
      // Bounded: a relay set that never answers must not block the QR forever,
      // so after 3s we show it anyway and take our chances — no worse than the
      // old behaviour, and only reachable when every signalling relay is slow.
      // 8s, not 3s: with `prewarmConnectRelays` the sockets are normally already
      // open and this resolves instantly, so the bound only matters when the
      // relays really are slow — and there, giving up early is what produced the
      // missed response in the first place.
      let subsLiveTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        subsLive,
        new Promise<void>((resolve) => { subsLiveTimer = setTimeout(resolve, 8000); }),
      ]);
      clearTimeout(subsLiveTimer);
      if (signal.aborted) throw new Error('aborted');
      onUri(uri);

      const result = await resultPromise;

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
      await persistBunkerClientKey(login);
      addLogin(login);
    },

    // Login via nostrconnect:// deep link (Amber on Android)
    async amberConnect(signal?: AbortSignal): Promise<void> {
      // Reuse a persisted client key across sessions. Amber grants "always" to a
      // specific client pubkey; generating a fresh key every login made Amber
      // treat each connection as a new app and re-prompt every time. This key
      // only authorizes the NIP-46 channel (revocable in Amber), not identity.
      //
      // Stored AES-GCM-encrypted in IndexedDB (lib/webKeyStore), NOT as a
      // plaintext nsec in localStorage as it was: a `nsec1…` sitting in
      // localStorage is readable by any script in the origin and by anything
      // that snapshots browser storage, and whoever reads it can pose as this
      // client to Amber. Legacy plaintext copies are migrated on first sight and
      // then removed. (M10)
      const AMBER_CLIENT_KEY = 'corkboard:amber-client-nsec';
      let sk: Uint8Array | undefined;
      const decodeNsec = (value: string | null): Uint8Array | undefined => {
        if (!value) return undefined;
        try {
          const decoded = nip19.decode(value);
          return decoded.type === 'nsec' ? (decoded.data as Uint8Array) : undefined;
        } catch { return undefined; }
      };

      sk = decodeNsec(await loadSecret(AMBER_CLIENT_SECRET_ID).catch(() => null));

      if (!sk) {
        // One-time migration of the legacy plaintext localStorage copy.
        let legacy: string | null = null;
        try { legacy = localStorage.getItem(AMBER_CLIENT_KEY); } catch { /* unavailable */ }
        const migrated = decodeNsec(legacy);
        if (migrated) {
          sk = migrated;
          // Encrypt first, and only then drop the plaintext — a crash between
          // the two must not destroy the only copy, which would make Amber
          // re-prompt for permission as if this were a brand-new app.
          if (await storeSecret(AMBER_CLIENT_SECRET_ID, nip19.nsecEncode(migrated))) {
            try { localStorage.removeItem(AMBER_CLIENT_KEY); } catch { /* ignore */ }
          }
        }
      }

      if (!sk) {
        sk = generateSecretKey();
        // If the encrypted store is unavailable, do NOT fall back to plaintext:
        // the cost is only that Amber re-prompts next session, which is a
        // usability wrinkle, not a lost account. Trading key confidentiality for
        // one fewer tap is not a trade to make silently.
        await storeSecret(AMBER_CLIENT_SECRET_ID, nip19.nsecEncode(sk)).catch(() => false);
      }
      const clientPubkey = getPublicKey(sk);
      const clientNsec = nip19.nsecEncode(sk);
      const clientSigner = new NSecSigner(sk);
      const secretBytes2 = crypto.getRandomValues(new Uint8Array(16));
      const secret = Array.from(secretBytes2).map(b => b.toString(16).padStart(2, '0')).join('');
      // relay.nsec.app first — Amber uses it as its default signaling relay
      const connectRelays = [NSEC_APP_RELAY, ...NOSTRCONNECT_RELAYS];

      // Build nostrconnect:// URI per NIP-46
      const params = new URLSearchParams();
      for (const r of connectRelays) params.append('relay', r);
      params.append('secret', secret);
      params.append('name', 'corkboards.me');
      params.append('url', 'https://corkboards.me');
      params.append('perms', 'get_public_key,sign_event,nip44_encrypt,nip44_decrypt');

      // Inner abort controller — aborted as soon as we get the connect response,
      // which cleanly closes all the connect subscriptions. Without this, the
      // abandoned for-await generators keep reading on the same relay and fill
      // NRelay1's buffer, BLOCKING the subsequent NConnectSigner.getPublicKey()
      // response from being delivered — the "hangs 30-60s on the login screen"
      // symptom. (nostrconnect() already does this; amberConnect() didn't.)
      const connectAbort = new AbortController();
      signal?.addEventListener('abort', () => connectAbort.abort());

      // Open direct relay connections (not through NPool)
      const relays = connectRelays.map(url => createRelayDirect(url, { backoff: false, idleTimeout: false }));
      const subs = relays.map(relay =>
        relay.req(
          [{ kinds: [24133], '#p': [clientPubkey] }],
          { signal: connectAbort.signal },
        )
      );

      // Listen for signer's connect response — race all relays. Track WHICH
      // relay delivered the response so we reuse that (proven-reachable, fastest)
      // relay for the NConnectSigner below, instead of blindly using relays[0].
      const responsePromise = new Promise<{ pubkey: string; relayIndex: number }>((resolve, reject) => {
        let resolved = false;
        signal?.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

        subs.forEach((sub, relayIndex) => {
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
                      connectAbort.abort(); // close connect subs so they don't block getPublicKey
                      resolve({ pubkey: event.pubkey, relayIndex });
                      return;
                    }
                  } catch { /* not our response */ }
                }
              }
            } catch { /* subscription closed or errored */ }
          })();
        });
      });

      // Trigger Amber — use Intent URI on Android, link click on desktop
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) {
        // Amber isn't on the Play Store — when it isn't installed, send users to
        // the Zap Store (the Nostr-native Android app store that distributes it).
        const fallback = encodeURIComponent('https://zapstore.dev');
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
      const { pubkey: bunkerPubkey, relayIndex } = await responsePromise;

      // Get the user's actual pubkey via NIP-46 over the relay that actually
      // delivered Amber's response (proven reachable) — not a hardcoded relays[0]
      // that Amber may not be answering on, which made getPublicKey crawl toward
      // its 60s timeout (the "hangs 30-60s on the login screen" symptom).
      const signer = new NConnectSigner({
        relay: relays[relayIndex],
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
      await persistBunkerClientKey(login);
      addLogin(login);
    },

    /**
     * Log out a single account. Stashes its per-user data, removes the login
     * credential, and clears in-memory caches. Does NOT destroy other accounts.
     * Returns the remaining logins so the caller can switch or redirect.
     */
    async logoutAccount(pubkey: string): Promise<{ remaining: typeof logins }> {
      // Stash per-user IDB data so it survives for potential re-login
      await handleLogoutStorageAsync(pubkey);

      // Remove the login credential for this account
      const login = logins.find(l => l.pubkey === pubkey);
      if (login) {
        if (isTauri) await keychainDelete(`nsec:${login.pubkey}`);
        else await deleteNsec(login.pubkey).catch(() => {});
        // Drop this account's encrypted NIP-46 client key too — leaving it
        // behind keeps a live credential for a signing channel the user just
        // ended. (The Amber client key is deliberately account-agnostic and
        // survives, so Amber doesn't re-prompt on every re-login.)
        await deleteSecret(bunkerClientSecretId(login.pubkey)).catch(() => {});
        removeLogin(login.id);
      }

      // Clear in-memory caches (they're from the departing user)
      clearProfileMemCache();
      clearCollapsedNotesModuleState();
      clearNoteCardCache();
      await clearNotesCache().catch(() => {});

      // Clear session-scoped state
      try {
        sessionStorage.removeItem('corkboard:scroll-positions');
        sessionStorage.removeItem('corkboard:active-tab');
        sessionStorage.removeItem('corkboard:soft-dismissed');
        sessionStorage.removeItem('corkboard:session-collapsed');
      } catch { /* unavailable */ }

      return { remaining: logins.filter(l => l.pubkey !== pubkey) };
    },

    /** Nuclear wipe — destroys ALL local data. Nothing survives. */
    async nuclearWipe(onProgress?: (step: string) => void): Promise<void> {
      const log = onProgress || (() => {});

      log('Removing login credentials...');
      // Collect every pubkey we can find — not just currently-loaded logins, but
      // also any orphaned per-user namespaced keys (`user:<pubkey>:…`) left by a
      // prior partial logout. Otherwise a stale `nsec:<pubkey>` keychain entry
      // could survive a "wipe everything".
      const pubkeysToWipe = new Set<string>(logins.map(l => l.pubkey));
      if (isTauri) {
        try {
          for (const k of await idbKeys()) {
            const m = /^user:([0-9a-f]{64}):/.exec(k);
            if (m) pubkeysToWipe.add(m[1]);
          }
        } catch { /* enumeration best-effort */ }
        for (const pk of pubkeysToWipe) {
          await keychainDelete(`nsec:${pk}`);
        }
      } else {
        // Web: destroy all encrypted nsec material + close its DB connection so
        // the deleteAllDbs() sweep below isn't blocked.
        await wipeKeyStore().catch(() => {});
      }
      for (const l of [...logins]) {
        removeLogin(l.id);
      }

      log('Clearing localStorage...');
      // Preserve the image-proxy template across the wipe: it's a device-level
      // IP-hiding preference, not account data, and silently reverting it to off
      // on logout would strip the user's chosen privacy protection for the next
      // (even logged-out) session. Re-applied right after the clear.
      let preservedImageProxy: string | null = null;
      try { preservedImageProxy = localStorage.getItem(IMAGE_PROXY_TEMPLATE_KEY); } catch { /* */ }
      localStorage.clear();
      if (preservedImageProxy) { try { localStorage.setItem(IMAGE_PROXY_TEMPLATE_KEY, preservedImageProxy); } catch { /* */ } }
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
