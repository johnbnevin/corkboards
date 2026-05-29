/**
 * createTauriNsecSigner — a NostrSigner backed by the Rust keychain signer.
 *
 * For `nsec` logins running inside the Tauri desktop app, the secret key lives
 * only in the OS keychain and Rust; signing and NIP-04/44 encryption are done in
 * Rust (signer.rs) and the nsec never enters JS memory or localStorage. This
 * object implements the same `NostrSigner` interface as @nostrify's NSecSigner,
 * so it is a drop-in replacement in useCurrentUser.
 */
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import {
  tauriSignEvent,
  tauriNip44Encrypt,
  tauriNip44Decrypt,
  tauriNip04Encrypt,
  tauriNip04Decrypt,
} from './tauri';

export function createTauriNsecSigner(pubkey: string): NostrSigner {
  return {
    async getPublicKey(): Promise<string> {
      return pubkey;
    },
    async signEvent(event): Promise<NostrEvent> {
      const signed = await tauriSignEvent(pubkey, {
        kind: event.kind,
        content: event.content ?? '',
        tags: event.tags ?? [],
        created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      });
      return signed as unknown as NostrEvent;
    },
    nip44: {
      encrypt: (peerPubkey, plaintext) => tauriNip44Encrypt(pubkey, peerPubkey, plaintext),
      decrypt: (peerPubkey, ciphertext) => tauriNip44Decrypt(pubkey, peerPubkey, ciphertext),
    },
    nip04: {
      encrypt: (peerPubkey, plaintext) => tauriNip04Encrypt(pubkey, peerPubkey, plaintext),
      decrypt: (peerPubkey, ciphertext) => tauriNip04Decrypt(pubkey, peerPubkey, ciphertext),
    },
  };
}
