/**
 * useSignerConnect — NIP-46 Amber login for mobile.
 * Opens Amber (Android intent) or a nostrconnect:// deep link (iOS).
 *
 * TODO(NIP-55): on Android this should try the *local* signer path first.
 * NIP-55 is device-local IPC (intents + ContentResolver) — no network, nothing
 * to observe. NIP-46 routes every signing request through a signalling relay
 * that sees the timing and shape of everything the user signs; it keeps the key
 * safe but not the behaviour. SKILL.md's cypherpunk defaults are explicit that
 * Android should be NIP-55 first with NIP-46 as fallback, not the reverse.
 * Implementing it means a native module (Amber's ContentResolver API), which is
 * a deliberate feature decision rather than a bug fix, so it is left flagged
 * here rather than half-built.
 */
import { useState, useRef, useCallback } from 'react';
import { Linking, Platform } from 'react-native';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import type { NRelay1 } from '@nostrify/nostrify';
import { NSecSigner, NConnectSigner } from '@nostrify/nostrify';
import { useAuth } from '../lib/AuthContext';
import { createRelay, registerAuthRelay } from '../lib/NostrProvider';
import { NSEC_APP_RELAY, NOSTRCONNECT_RELAYS } from '@core/relayConstants';

/**
 * Signalling relays advertised in the nostrconnect:// URI and listened on.
 *
 * A single hardcoded relay is a chokepoint: while `relay.nsec.app` was the only
 * one, that host being down, blocked, or simply choosing not to carry kind-24133
 * meant nobody could log in with a remote signer at all — and it also meant one
 * operator saw every corkboards NIP-46 handshake. NIP-46 allows multiple `relay`
 * params, signers connect to all of them, and we listen on all of them, so the
 * first to deliver the response wins and any single failure is survivable.
 * relay.nsec.app stays in the set because nsec.app's own signer defaults to it.
 */
const SIGNALLING_RELAYS = [...new Set([...NOSTRCONNECT_RELAYS, NSEC_APP_RELAY])];

// `_type` is kept in the signature for API stability and to leave room for
// future signer kinds (e.g. nsec.app). It is intentionally unused today;
// underscore prefix marks it as such for linters. If a future kind is added,
// restore the dep array entry and branch on it.
export function useSignerConnect(_type: 'amber') {
  const { loginWithBunker } = useAuth();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const connect = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setConnecting(true);
    setError(null);

    try {
      const sk = generateSecretKey();
      const clientPubkey = getPublicKey(sk);
      const clientNsec = nip19.nsecEncode(sk);
      const clientSigner = new NSecSigner(sk);

      const secretBytes = crypto.getRandomValues(new Uint8Array(16));
      const secret = Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      const params = new URLSearchParams();
      for (const url of SIGNALLING_RELAYS) params.append('relay', url);
      params.append('secret', secret);
      params.append('name', 'corkboards.me');
      params.append('url', 'https://corkboards.me');
      params.append('perms', 'get_public_key,sign_event,nip44_encrypt,nip44_decrypt');

      const connectUri = `nostrconnect://${clientPubkey}?${params.toString()}`;

      if (Platform.OS === 'android') {
        // Amber isn't on the Play Store — when it isn't installed, send users to
        // the Zap Store (the Nostr-native Android app store that distributes it)
        // rather than a dead Play Store listing.
        const fallback = encodeURIComponent('https://zapstore.dev');
        await Linking.openURL(
          `intent://${clientPubkey}?${params.toString()}#Intent;scheme=nostrconnect;package=com.greenart7c3.nostrsigner;S.browser_fallback_url=${fallback};end`
        );
      } else {
        await Linking.openURL(connectUri);
      }

      // Listen for the NIP-46 connect response on EVERY signalling relay.
      // Same treatment as AuthContext's bunker relays: go through createRelay so
      // the connection carries the NIP-42 AUTH handler (a raw NRelay1 has none,
      // so an AUTH-gated signalling relay would silently return nothing and the
      // connect flow would hang), and register it as a deliberate connection.
      const connections = SIGNALLING_RELAYS.map((url) => {
        registerAuthRelay(url);
        return { url, relay: createRelay(url, { backoff: false }) };
      });

      // Inner abort — closed once we have the response so the abandoned connect
      // subscriptions don't keep reading and fill NRelay1's buffer, which would
      // block the subsequent getPublicKey() response on the same relay (the
      // "hangs 30-60s on the login screen" symptom). Mirrors web's amberConnect.
      const connectAbort = new AbortController();
      signal.addEventListener('abort', () => connectAbort.abort());

      let winner: { url: string; relay: NRelay1 } | null = null;
      try {
        const bunkerPubkey = await new Promise<string>((resolve, reject) => {
          let resolved = false;
          let finished = 0;
          signal.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

          for (const connection of connections) {
            (async () => {
              try {
                const sub = connection.relay.req(
                  [{ kinds: [24133], '#p': [clientPubkey] }],
                  { signal: connectAbort.signal },
                );
                for await (const msg of sub) {
                  if (resolved) return;
                  if (msg[0] === 'EVENT') {
                    const event = msg[2];
                    try {
                      const decrypted = await clientSigner.nip44!.decrypt(event.pubkey, event.content);
                      const response = JSON.parse(decrypted);
                      if (typeof response === 'object' && response !== null && response.result === secret) {
                        resolved = true;
                        winner = connection;
                        connectAbort.abort(); // close subs so they don't block getPublicKey
                        resolve(event.pubkey);
                        return;
                      }
                    } catch { /* not our response */ }
                  }
                }
              } catch { /* relay closed */ } finally {
                // Only give up once EVERY relay has gone quiet — one dead host
                // must not fail a login the others could still complete.
                finished++;
                if (!resolved && finished === connections.length) {
                  reject(new Error('No signalling relay delivered a connect response'));
                }
              }
            })();
          }
        });

        // Sign over the relay that actually answered; close the rest.
        const winning = winner as unknown as { url: string; relay: NRelay1 };
        for (const connection of connections) {
          if (connection !== winner) { try { connection.relay.close(); } catch { /* */ } }
        }

        // Get user pubkey via NIP-46
        const connectSigner = new NConnectSigner({
          relay: winning.relay,
          pubkey: bunkerPubkey,
          signer: clientSigner,
          timeout: 60_000,
        });
        const userPubkey = await connectSigner.getPublicKey();

        // Persist the responding relay first, with the rest as alternatives, so
        // a later session isn't pinned to a host that may have gone away.
        const bunkerRelays = [winning.url, ...SIGNALLING_RELAYS.filter(u => u !== winning.url)];
        await loginWithBunker(bunkerPubkey, clientNsec, bunkerRelays, userPubkey);
      } catch (err) {
        for (const connection of connections) {
          if (connection !== winner) { try { connection.relay.close(); } catch { /* */ } }
        }
        throw err;
      }
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  }, [loginWithBunker]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setConnecting(false);
    setError(null);
  }, []);

  return { connect, connecting, error, cancel };
}
