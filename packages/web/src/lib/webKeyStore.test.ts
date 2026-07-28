// Encrypted-at-rest nsec storage: encrypt/decrypt roundtrip, deletion, and the
// startup migration that blanks plaintext nsecs out of localStorage['corkboard:login'].
// fake-indexeddb (test setup) structured-clones CryptoKey objects, so the full
// store → reload-simulation (mem-cache cleared) → decrypt path is exercised.
import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  storeNsec,
  loadNsec,
  deleteNsec,
  prepareLoginStorage,
  clearKeyStoreMemCache,
  bunkerClientSecretId,
} from './webKeyStore';
import { createWebNsecSigner } from './webNsecSigner';

const STORAGE_KEY = 'corkboard:login';

function freshAccount(): { pubkey: string; nsec: string } {
  const sk = generateSecretKey();
  return { pubkey: getPublicKey(sk), nsec: nip19.nsecEncode(sk) };
}

function persistedNsecLogin(pubkey: string, nsec: string) {
  return {
    id: `nsec:${pubkey}`,
    type: 'nsec',
    pubkey,
    createdAt: new Date().toISOString(),
    data: { nsec },
  };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  clearKeyStoreMemCache();
});

describe('webKeyStore', () => {
  it('roundtrips an nsec through encrypted IDB storage (survives mem-cache loss)', async () => {
    const { pubkey, nsec } = freshAccount();
    expect(await storeNsec(pubkey, nsec)).toBe(true);

    clearKeyStoreMemCache(); // simulate reload — force decrypt from IDB
    expect(await loadNsec(pubkey)).toBe(nsec);
  });

  it('returns null for an unknown pubkey without throwing', async () => {
    expect(await loadNsec('0'.repeat(64))).toBeNull();
  });

  it('deleteNsec removes the record (logout)', async () => {
    const { pubkey, nsec } = freshAccount();
    await storeNsec(pubkey, nsec);
    await deleteNsec(pubkey);
    clearKeyStoreMemCache();
    expect(await loadNsec(pubkey)).toBeNull();
  });

  it('keys entries per pubkey (multi-account)', async () => {
    const a = freshAccount();
    const b = freshAccount();
    await storeNsec(a.pubkey, a.nsec);
    await storeNsec(b.pubkey, b.nsec);
    await deleteNsec(a.pubkey);
    clearKeyStoreMemCache();
    expect(await loadNsec(a.pubkey)).toBeNull();
    expect(await loadNsec(b.pubkey)).toBe(b.nsec);
  });

  it('returns null (not a crash) when the stored record is undecryptable garbage', async () => {
    const { pubkey } = freshAccount();
    // Plant a corrupt record: valid CryptoKey but ciphertext that never came from it.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('corkboard-keys', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('nsec')) open.result.createObjectStore('nsec');
      };
      open.onsuccess = () => {
        const tx = open.result.transaction('nsec', 'readwrite');
        tx.objectStore('nsec').put(
          { key, iv: new Uint8Array(12), ciphertext: new Uint8Array(48).buffer },
          pubkey,
        );
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

    expect(await loadNsec(pubkey)).toBeNull();
  });
});

describe('prepareLoginStorage (startup migration)', () => {
  it('blanks plaintext nsecs in localStorage and encrypts them into IDB', async () => {
    const { pubkey, nsec } = freshAccount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([persistedNsecLogin(pubkey, nsec)]));

    await prepareLoginStorage(STORAGE_KEY);

    // Plaintext gone from localStorage
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(state[0].data.nsec).toBe('');
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(nsec);

    // ...but recoverable from the encrypted store, even after "reload"
    clearKeyStoreMemCache();
    expect(await loadNsec(pubkey)).toBe(nsec);
  });

  it('migrates multiple accounts, including a bunker login’s client key', async () => {
    const a = freshAccount();
    const b = freshAccount();
    const bunkerLogin = {
      id: `bunker:${'c'.repeat(64)}`,
      type: 'bunker',
      pubkey: 'c'.repeat(64),
      createdAt: new Date().toISOString(),
      data: { bunkerPubkey: 'd'.repeat(64), clientNsec: 'nsec1clientonly', relays: ['wss://r.example'] },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      persistedNsecLogin(a.pubkey, a.nsec),
      bunkerLogin,
      persistedNsecLogin(b.pubkey, b.nsec),
    ]));

    await prepareLoginStorage(STORAGE_KEY);

    const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(state[0].data.nsec).toBe('');
    expect(state[2].data.nsec).toBe('');

    // The bunker login's NIP-46 CLIENT key gets the same treatment as an
    // identity key. It used to be left in localStorage as plaintext on the
    // grounds that it is "only" a channel key — but a signer that granted this
    // client an "always" approval will auto-approve signing requests from
    // anyone holding it, so exfiltrating it yields remote signing as the user.
    // Everything else about the entry must survive the rewrite untouched.
    expect(state[1].data.clientNsec).toBe('');
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('nsec1clientonly');
    expect(state[1]).toEqual({
      ...bunkerLogin,
      data: { ...bunkerLogin.data, clientNsec: '' },
    });

    clearKeyStoreMemCache();
    expect(await loadNsec(a.pubkey)).toBe(a.nsec);
    expect(await loadNsec(b.pubkey)).toBe(b.nsec);
    // Blanking is only safe because the key is recoverable — useCurrentUser
    // reads it back through peekSecret to build the bunker signer.
    expect(await loadNsec(bunkerClientSecretId(bunkerLogin.pubkey))).toBe('nsec1clientonly');
  });

  it('is idempotent: a second run with already-blanked state changes nothing and warms the cache', async () => {
    const { pubkey, nsec } = freshAccount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([persistedNsecLogin(pubkey, nsec)]));
    await prepareLoginStorage(STORAGE_KEY);
    const afterFirst = localStorage.getItem(STORAGE_KEY);

    clearKeyStoreMemCache();
    await prepareLoginStorage(STORAGE_KEY); // restore path (blanked entry → warm decrypt)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(afterFirst);
    expect(await loadNsec(pubkey)).toBe(nsec);
  });

  it('handles absent or malformed state without throwing', async () => {
    await expect(prepareLoginStorage(STORAGE_KEY)).resolves.toBeUndefined();
    localStorage.setItem(STORAGE_KEY, 'not json {');
    await expect(prepareLoginStorage(STORAGE_KEY)).resolves.toBeUndefined();
    localStorage.setItem(STORAGE_KEY, '{"an":"object"}');
    await expect(prepareLoginStorage(STORAGE_KEY)).resolves.toBeUndefined();
  });
});

describe('createWebNsecSigner', () => {
  it('signs events with the decrypted key', async () => {
    const { pubkey, nsec } = freshAccount();
    await storeNsec(pubkey, nsec);
    clearKeyStoreMemCache(); // force the lazy IDB + decrypt path

    const signer = createWebNsecSigner(pubkey);
    expect(await signer.getPublicKey()).toBe(pubkey);
    const signed = await signer.signEvent({
      kind: 1,
      content: 'hello',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(signed.pubkey).toBe(pubkey);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('rejects signing (without crashing) when no key material exists', async () => {
    const signer = createWebNsecSigner('f'.repeat(64));
    expect(await signer.getPublicKey()).toBe('f'.repeat(64));
    await expect(signer.signEvent({
      kind: 1,
      content: 'x',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    })).rejects.toThrow(/log in again/);
  });
});
