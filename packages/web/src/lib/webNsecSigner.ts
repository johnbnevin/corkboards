/**
 * createWebNsecSigner — a NostrSigner backed by the encrypted IndexedDB key
 * store (lib/webKeyStore).
 *
 * For `nsec` logins on plain web, the persisted login object carries a blanked
 * `data.nsec`; the real key sits AES-GCM-encrypted in IndexedDB under a
 * non-extractable CryptoKey. This signer decrypts lazily on first use (the
 * startup restore in webKeyStore.prepareLoginStorage usually pre-warms the
 * cache, making this synchronous-fast) and then delegates to a regular
 * NSecSigner. It implements the same `NostrSigner` interface, so it is a
 * drop-in replacement in useCurrentUser — the web counterpart of
 * lib/tauriSigner.ts.
 *
 * If the key material is missing or undecryptable, every operation except
 * getPublicKey rejects with a clear error: the account behaves as logged-out
 * (cannot sign) without crashing the app.
 */
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import { NSecSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { loadNsec } from './webKeyStore';

export function createWebNsecSigner(pubkey: string): NostrSigner {
  let signerPromise: Promise<NSecSigner> | null = null;

  const getSigner = (): Promise<NSecSigner> => {
    if (!signerPromise) {
      signerPromise = (async () => {
        const nsec = await loadNsec(pubkey);
        if (!nsec) {
          throw new Error('No key material available for this account — please log in again.');
        }
        const decoded = nip19.decode(nsec);
        if (decoded.type !== 'nsec') {
          throw new Error('Stored key material is not a valid nsec.');
        }
        return new NSecSigner(decoded.data);
      })().catch((err) => {
        signerPromise = null; // allow retry (e.g. after re-login re-stores the key)
        throw err;
      });
    }
    return signerPromise;
  };

  return {
    async getPublicKey(): Promise<string> {
      return pubkey;
    },
    async signEvent(event): Promise<NostrEvent> {
      return (await getSigner()).signEvent(event);
    },
    nip44: {
      encrypt: async (peerPubkey, plaintext) => (await getSigner()).nip44.encrypt(peerPubkey, plaintext),
      decrypt: async (peerPubkey, ciphertext) => (await getSigner()).nip44.decrypt(peerPubkey, ciphertext),
    },
    nip04: {
      encrypt: async (peerPubkey, plaintext) => (await getSigner()).nip04.encrypt(peerPubkey, plaintext),
      decrypt: async (peerPubkey, ciphertext) => (await getSigner()).nip04.decrypt(peerPubkey, ciphertext),
    },
  };
}
