/**
 * Lazy bunker (NIP-46) user — resolves the encrypted client key ON DEMAND.
 *
 * The persisted bunker login carries a blanked `clientNsec`; the real key
 * lives AES-GCM-encrypted in IndexedDB (lib/webKeyStore). main.tsx only
 * BOUNDED-waits for `prepareLoginStorage` to warm the synchronous peek cache,
 * so on a slow IndexedDB (WebKitGTK on the desktop build, reliably) the app
 * mounts before the cache is warm, `peekSecret` returns null, and
 * useCurrentUser's builder used to THROW — every bunker login was skipped,
 * `user` came up undefined, and the app rendered the login screen despite
 * valid logins sitting in localStorage. Nothing re-rendered when the cache
 * warmed moments later, so it wasn't a flash — the session was gone until the
 * user logged in again. Multi-account made it common because every add/switch
 * is another reload rolling that dice.
 *
 * Same pattern as createWebNsecSigner: hand back a duck-typed NUser whose
 * signer resolves the key (peek first, then the async store) on first use.
 * Mount can no longer fail; a genuinely missing key surfaces as a clear error
 * on the first signing attempt instead of a silent logout.
 */
import { NUser } from '@nostrify/react/login';
import type { NLoginType } from '@nostrify/react/login';
import type { NPool, NostrEvent } from '@nostrify/nostrify';
import { peekSecret, loadSecret, bunkerClientSecretId } from '@/lib/webKeyStore';

type BunkerLogin = Extract<NLoginType, { type: 'bunker' }>;

export function createLazyBunkerUser(login: BunkerLogin, nostr: NPool): NUser {
  let userPromise: Promise<NUser> | null = null;
  const real = (): Promise<NUser> => {
    userPromise ??= (async () => {
      const id = bunkerClientSecretId(login.pubkey);
      const clientNsec = peekSecret(id) ?? (await loadSecret(id).catch(() => null));
      if (!clientNsec) {
        throw new Error('Bunker client key unavailable — please reconnect your remote signer');
      }
      return NUser.fromBunkerLogin(
        { ...login, data: { ...login.data, clientNsec } } as BunkerLogin,
        nostr,
      );
    })().catch((err) => {
      // Reset so a transient storage failure retries on the next signer use
      // instead of caching the error for the rest of the session.
      userPromise = null;
      throw err;
    });
    return userPromise;
  };

  return {
    method: 'bunker',
    pubkey: login.pubkey,
    signer: {
      getPublicKey: async () => (await real()).signer.getPublicKey(),
      signEvent: async (event: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>) =>
        (await real()).signer.signEvent(event),
      nip04: {
        encrypt: async (pubkey: string, plaintext: string) =>
          (await real()).signer.nip04!.encrypt(pubkey, plaintext),
        decrypt: async (pubkey: string, ciphertext: string) =>
          (await real()).signer.nip04!.decrypt(pubkey, ciphertext),
      },
      nip44: {
        encrypt: async (pubkey: string, plaintext: string) =>
          (await real()).signer.nip44!.encrypt(pubkey, plaintext),
        decrypt: async (pubkey: string, ciphertext: string) =>
          (await real()).signer.nip44!.decrypt(pubkey, ciphertext),
      },
    },
  } as unknown as NUser;
}
