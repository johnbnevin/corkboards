/**
 * useSignerConnect — NIP-46 Amber login for mobile.
 * Opens Amber (Android intent) or a nostrconnect:// deep link (iOS).
 * Uses relay.nsec.app as the primary signaling relay.
 */
import { useState, useRef, useCallback } from 'react';
import { Linking, Platform } from 'react-native';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { NSecSigner, NConnectSigner, NRelay1 } from '@nostrify/nostrify';
import { useAuth } from '../lib/AuthContext';
import { NSEC_APP_RELAY } from '@core/relayConstants';

export function useSignerConnect(type: 'amber') {
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
      params.append('relay', NSEC_APP_RELAY);
      params.append('secret', secret);
      params.append('name', 'corkboards.me');
      params.append('url', 'https://corkboards.me');
      params.append('perms', 'get_public_key,sign_event,nip44_encrypt,nip44_decrypt');

      const connectUri = `nostrconnect://${clientPubkey}?${params.toString()}`;

      if (Platform.OS === 'android') {
        const fallback = encodeURIComponent('https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner');
        await Linking.openURL(
          `intent://${clientPubkey}?${params.toString()}#Intent;scheme=nostrconnect;package=com.greenart7c3.nostrsigner;S.browser_fallback_url=${fallback};end`
        );
      } else {
        await Linking.openURL(connectUri);
      }

      // Listen for NIP-46 connect response on relay.nsec.app
      const relay = new NRelay1(NSEC_APP_RELAY);

      const bunkerPubkey = await new Promise<string>((resolve, reject) => {
        let resolved = false;
        signal.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

        (async () => {
          try {
            const sub = relay.req([{ kinds: [24133], '#p': [clientPubkey] }], { signal });
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
                  }
                } catch { /* not our response */ }
              }
            }
          } catch { /* relay closed */ }
        })();
      });

      // Get user pubkey via NIP-46
      const connectSigner = new NConnectSigner({
        relay,
        pubkey: bunkerPubkey,
        signer: clientSigner,
        timeout: 60_000,
      });
      const userPubkey = await connectSigner.getPublicKey();

      await loginWithBunker(bunkerPubkey, clientNsec, [NSEC_APP_RELAY], userPubkey);
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  }, [type, loginWithBunker]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setConnecting(false);
    setError(null);
  }, []);

  return { connect, connecting, error, cancel };
}
