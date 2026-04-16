import React, { useState, useCallback, useMemo, useRef, useEffect, createContext, useContext } from 'react';
import type { NRelay1 } from '@nostrify/nostrify';
import { createRelay } from '@/components/NostrProvider';
import { debugLog } from '@/lib/debug';
import { getPublicKey } from 'nostr-tools';
import { hexToBytes, bytesToHex } from 'nostr-tools/utils';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt, getConversationKey } from 'nostr-tools/nip44';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { finalizeEvent } from 'nostr-tools/pure';

type EncryptionType = 'nip44_v2' | 'nip04';

// Cache wallet encryption capability per wallet pubkey to avoid re-fetching on every payment
const walletEncryptionCache = new Map<string, EncryptionType>();

interface NwcParsed {
  walletPubkey: string;
  relay: string;
  secret: Uint8Array;
  clientPubkey: string;
}

function parseNwcUri(uri: string): NwcParsed {
  const withoutScheme = uri.replace('nostr+walletconnect://', '');
  const [walletPubkey, queryString] = withoutScheme.split('?');
  if (!walletPubkey || !queryString) throw new Error('Invalid NWC URI format');

  const params = new URLSearchParams(queryString);
  const relay = params.get('relay');
  const secretHex = params.get('secret');
  if (!relay || !secretHex) throw new Error('Missing relay or secret in NWC URI');
  if (!relay.startsWith('wss://')) throw new Error('NWC relay must use wss:// scheme');

  const secret = hexToBytes(secretHex);
  const clientPubkey = getPublicKey(secret);

  return { walletPubkey, relay, secret, clientPubkey };
}

/** Check wallet's kind 13194 info event to detect encryption support.
 *  Returns 'nip44_v2' if supported, 'nip04' as fallback for older wallets. */
async function detectEncryption(relay: NRelay1, walletPubkey: string): Promise<EncryptionType> {
  try {
    for await (const msg of relay.req([{ kinds: [13194], authors: [walletPubkey], limit: 1 }])) {
      if (msg[0] === 'EOSE') break;
      if (msg[0] === 'EVENT') {
        const encTag = msg[2].tags?.find((t: string[]) => t[0] === 'encryption');
        if (encTag && encTag[1]?.includes('nip44_v2')) {
          debugLog('[nwc] Wallet supports NIP-44');
          return 'nip44_v2';
        }
        // Check v tag as fallback (Alby pattern)
        const vTag = msg[2].tags?.find((t: string[]) => t[0] === 'v');
        if (vTag && vTag[1]?.includes('1.0')) {
          debugLog('[nwc] Wallet supports NIP-44 (via v tag)');
          return 'nip44_v2';
        }
        debugLog('[nwc] Wallet does not advertise NIP-44 — falling back to NIP-04');
        return 'nip04';
      }
    }
  } catch {
    // Info event fetch failed — fall through to default
  }
  debugLog('[nwc] No wallet info event — assuming NIP-44');
  return 'nip44_v2';
}

export interface NwcContextValue {
  nwcUri: string;
  setNwcUri: (uri: string) => void;
  isConnected: boolean;
  walletRelay: string | null;
  payInvoice: (bolt11: string) => Promise<{ preimage: string }>;
  disconnect: () => void;
  isProcessing: boolean;
}

const NwcContext = createContext<NwcContextValue | null>(null);

export function NwcProvider({ children }: { children: React.ReactNode }) {
  // NWC URI is kept in React state only — never persisted to localStorage/IDB.
  // The URI contains a wallet secret; ephemeral state prevents XSS exfiltration.
  const [nwcUri, setNwcUriRaw] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Memoize parsed NWC params so we don't re-parse on every payInvoice call
  const parsed = useMemo(() => {
    if (!nwcUri) return null;
    try {
      return parseNwcUri(nwcUri);
    } catch {
      return null;
    }
  }, [nwcUri]);

  const isConnected = parsed !== null;
  const walletRelay = parsed?.relay ?? null;

  // Pool the relay connection — one persistent connection per NWC URI.
  // Avoids opening a fresh WebSocket on every payInvoice() call.
  const relayRef = useRef<NRelay1 | null>(null);
  useEffect(() => {
    if (!parsed) {
      relayRef.current?.close();
      relayRef.current = null;
      return;
    }
    relayRef.current = createRelay(parsed.relay, { backoff: false });
    return () => {
      relayRef.current?.close();
      relayRef.current = null;
    };
  }, [parsed?.relay]); // eslint-disable-line react-hooks/exhaustive-deps

  // Validate before storing — reject non-NWC URIs and malformed ones
  const setNwcUri = useCallback((uri: string) => {
    if (!uri) { setNwcUriRaw(''); return; }
    if (!uri.startsWith('nostr+walletconnect://')) return; // reject non-NWC input
    parseNwcUri(uri); // throws on invalid — caller should catch
    setNwcUriRaw(uri);
  }, []);

  const disconnect = useCallback(() => {
    setNwcUriRaw('');
  }, []);

  const payInvoice = useCallback(async (bolt11: string): Promise<{ preimage: string }> => {
    if (!parsed || !relayRef.current) throw new Error('No NWC wallet connected');
    setIsProcessing(true);

    const relay = relayRef.current;
    const { walletPubkey, secret, clientPubkey } = parsed;

    try {
      // Detect wallet encryption support (cached after first check)
      if (!walletEncryptionCache.has(walletPubkey)) {
        const enc = await detectEncryption(relay, walletPubkey);
        walletEncryptionCache.set(walletPubkey, enc);
      }
      const encType = walletEncryptionCache.get(walletPubkey)!;

      // Encrypt the request payload
      const payload = JSON.stringify({ method: 'pay_invoice', params: { invoice: bolt11 } });
      const secretHex = bytesToHex(secret);
      const encryptedContent = encType === 'nip44_v2'
        ? nip44Encrypt(payload, getConversationKey(secret, walletPubkey))
        : await nip04Encrypt(secretHex, walletPubkey, payload);

      // Build and send request event
      const tags: string[][] = [['p', walletPubkey]];
      if (encType === 'nip44_v2') tags.push(['encryption', 'nip44_v2']);

      const requestEvent = finalizeEvent({
        kind: 23194,
        content: encryptedContent,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      }, secret);

      await relay.event(requestEvent);
      debugLog(`[nwc] Request sent (${encType})`);

      // Use AbortController to cancel the subscription without closing the pooled relay
      const controller = new AbortController();

      return await new Promise<{ preimage: string }>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            controller.abort();
            reject(new Error('NWC payment timed out after 60 seconds'));
          }
        }, 60000);

        (async () => {
          try {
            for await (const msg of relay.req([{
              kinds: [23195],
              authors: [walletPubkey],
              '#p': [clientPubkey],
              since: requestEvent.created_at - 10,
            }], { signal: controller.signal })) {
              if (settled) return;
              if (msg[0] === 'EVENT') {
                // Verify this response is for our request via e-tag
                const eTag = msg[2].tags?.find((t: string[]) => t[0] === 'e');
                if (eTag && eTag[1] !== requestEvent.id) continue;

                settled = true;
                clearTimeout(timeout);
                controller.abort(); // Stop the subscription (keeps relay alive)

                // Decrypt response
                const decrypted = encType === 'nip44_v2'
                  ? nip44Decrypt(msg[2].content, getConversationKey(secret, walletPubkey))
                  : await nip04Decrypt(secretHex, walletPubkey, msg[2].content);

                const response = JSON.parse(decrypted);
                debugLog('[nwc] Response: %s', response.error ? 'ERROR' : 'OK');
                if (response.error) {
                  reject(new Error(response.error.message || 'Payment failed'));
                } else {
                  resolve({ preimage: response.result?.preimage || '' });
                }
                return;
              }
            }
          } catch (err) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(err);
            }
          }
        })();
      });
    } finally {
      setIsProcessing(false);
    }
  }, [parsed]);

  const value: NwcContextValue = { nwcUri, setNwcUri, isConnected, walletRelay, payInvoice, disconnect, isProcessing };
  return <NwcContext.Provider value={value}>{children}</NwcContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNwc(): NwcContextValue {
  const ctx = useContext(NwcContext);
  if (!ctx) throw new Error('useNwc must be used within NwcProvider');
  return ctx;
}
