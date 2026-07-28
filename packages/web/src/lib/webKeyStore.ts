/**
 * webKeyStore — encrypted-at-rest storage for nsec secret keys on plain web.
 *
 * Web analogue of the Tauri OS-keychain path (see useLoginActions.nsec() and
 * lib/tauriSigner.ts): the login state persisted by @nostrify/react's
 * NostrLoginProvider (localStorage['corkboard:login']) carries a BLANKED
 * `data.nsec`; the real key material lives here, encrypted.
 *
 * ## Storage schema
 * - IndexedDB database `corkboard-keys` (v1), object store `nsec`, keyed by the
 *   account's hex pubkey (multi-account: one record per pubkey).
 * - Each record: `{ key: CryptoKey, iv: Uint8Array(12), ciphertext: ArrayBuffer }`
 *   where `key` is a NON-EXTRACTABLE AES-GCM-256 CryptoKey (stored via IDB's
 *   structured clone — the browser persists the key handle without ever
 *   exposing raw key bytes to JS) and `ciphertext` is the AES-GCM encryption
 *   of the UTF-8 nsec string under that key + iv.
 *
 * ## Threat model (honest limits)
 * This protects the nsec at rest on disk and against casual reads of
 * localStorage / IndexedDB contents: the ciphertext is useless without the
 * non-extractable CryptoKey, whose raw bytes can never be read from JS. It
 * does NOT stop an attacker with full JS execution in this origin (XSS) —
 * such code could call loadNsec() and decrypt exactly like the app does. The
 * strict CSP in index.html remains the primary XSS defense; this module is
 * defense-in-depth for at-rest exposure.
 */

const DB_NAME = 'corkboard-keys';
const STORE_NAME = 'nsec';
const DB_VERSION = 1;

interface KeyRecord {
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

// Decrypted nsecs for the current session. Seeded on login/migration and on
// first successful decrypt, so signers don't re-hit IDB + WebCrypto per use.
const memNsec = new Map<string, string>();

// ─── IndexedDB plumbing ──────────────────────────────────────────────────────

let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      // Auto-close on versionchange so deleteDatabase() (nuclear wipe) is
      // never blocked by our open connection.
      d.onversionchange = () => { d.close(); db = null; dbPromise = null; };
      d.onclose = () => { db = null; dbPromise = null; };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getDb(): Promise<IDBDatabase> {
  if (db) return db;
  if (!dbPromise) {
    dbPromise = openDb().then((d) => { db = d; return d; }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(pubkey: string, record: KeyRecord): Promise<void> {
  const database = await getDb();
  await wrapRequest(
    database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record, pubkey)
  );
}

async function getRecord(pubkey: string): Promise<KeyRecord | null> {
  const database = await getDb();
  const result = await wrapRequest<KeyRecord | undefined>(
    database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(pubkey)
  );
  return result ?? null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypt `nsec` under a fresh non-extractable AES-GCM key and persist both
 * (key handle + ciphertext + iv) in IndexedDB, keyed by pubkey. Also seeds the
 * in-memory session cache. Returns false (never throws) if persistence failed —
 * callers then fall back to legacy in-login storage so the user isn't locked out.
 */
export async function storeNsec(pubkey: string, nsec: string): Promise<boolean> {
  memNsec.set(pubkey, nsec);
  try {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable: raw key bytes are never readable from JS
      ['encrypt', 'decrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(nsec)
    );
    await putRecord(pubkey, { key, iv, ciphertext });
    return true;
  } catch (err) {
    console.error('[keystore] Failed to store encrypted nsec:', err);
    return false;
  }
}

/**
 * Decrypt and return the nsec for `pubkey`, or null if no record exists or
 * decryption fails (corrupt/foreign record). Never throws — a null return
 * means the account has no usable key material and behaves as logged-out.
 */
export async function loadNsec(pubkey: string): Promise<string | null> {
  const cached = memNsec.get(pubkey);
  if (cached) return cached;
  try {
    const record = await getRecord(pubkey);
    if (!record) return null;
    const plaintext = await crypto.subtle.decrypt(
      // Re-wrap the IV in a fresh ArrayBuffer-backed view: values read back from
      // IndexedDB widen to Uint8Array<ArrayBufferLike>, which no longer satisfies
      // BufferSource under the current TS DOM lib.
      { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
      record.key,
      record.ciphertext
    );
    const nsec = new TextDecoder().decode(plaintext);
    memNsec.set(pubkey, nsec);
    return nsec;
  } catch (err) {
    console.error(`[keystore] Failed to decrypt nsec for ${pubkey.slice(0, 8)}… — account will require re-login:`, err);
    return null;
  }
}

/** Remove the encrypted key material for one account (logout). */
export async function deleteNsec(pubkey: string): Promise<void> {
  memNsec.delete(pubkey);
  try {
    const database = await getDb();
    await wrapRequest(
      database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(pubkey)
    );
  } catch {
    // DB unavailable — nothing persisted there to delete.
  }
}

/** Wipe ALL key material (nuclear wipe): session cache + every IDB record. */
export async function wipeKeyStore(): Promise<void> {
  memNsec.clear();
  try {
    const database = await getDb();
    await wrapRequest(
      database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear()
    );
    // Close so the caller's subsequent deleteDatabase() isn't blocked.
    database.close();
    db = null;
    dbPromise = null;
  } catch {
    // DB unavailable — nothing persisted to wipe.
  }
}

/** Test hook: drop the in-memory session cache so reads must hit IDB. */
export function clearKeyStoreMemCache(): void {
  memNsec.clear();
}

// ─── Non-identity secrets (NIP-46 client keys) ───────────────────────────────
//
// A NIP-46 session needs an *ephemeral client* keypair — the key that
// authenticates our end of the signing channel to the bunker/Amber. It is NOT
// the user's identity key (it signs nothing on their behalf and is revocable at
// the signer), but it is still key material, and it was living as a plaintext
// `nsec1…` string in localStorage: readable by any script in the origin,
// visible in a devtools panel, and copied verbatim into anything that snapshots
// localStorage. "Lower-value" is not "worthless" — whoever holds it can pose as
// this client to the signer and ask it to sign.
//
// So it goes through the same at-rest encryption as the identity key: AES-GCM
// under a NON-EXTRACTABLE CryptoKey in IndexedDB. Same threat model caveat as
// the docblock above: this defends at-rest exposure, not XSS.
//
// Namespaced ids keep them from colliding with pubkey-keyed identity records
// (a pubkey is 64 hex chars and never contains ':').

/** Id for the persistent Amber (NIP-55/46 deep-link) client key. */
export const AMBER_CLIENT_SECRET_ID = 'client:amber';
/** Id for a bunker login's ephemeral client key, one per account. */
export function bunkerClientSecretId(pubkey: string): string {
  return `client:bunker:${pubkey}`;
}

/** Encrypt and persist a non-identity secret. Returns false (never throws) on failure. */
export function storeSecret(id: string, secret: string): Promise<boolean> {
  return storeNsec(id, secret);
}

/** Decrypt a non-identity secret, or null when absent/undecryptable. */
export function loadSecret(id: string): Promise<string | null> {
  return loadNsec(id);
}

/**
 * Synchronous read from the session cache ONLY.
 *
 * Exists because `useCurrentUser.buildUser` is synchronous and must produce a
 * bunker signer during render. `prepareLoginStorage` warms the cache before
 * React mounts, so by the time a component asks, the value is there.
 * Returns null when the cache is cold — callers must have a fallback.
 */
export function peekSecret(id: string): string | null {
  return memNsec.get(id) ?? null;
}

/** Remove one non-identity secret (logout). */
export function deleteSecret(id: string): Promise<void> {
  return deleteNsec(id);
}

// ─── Startup migration + restore ─────────────────────────────────────────────

interface PersistedLogin {
  id?: string;
  type?: string;
  pubkey?: string;
  data?: { nsec?: string; clientNsec?: string } | null;
}

/**
 * Startup migration + restore for plain web. MUST complete before
 * NostrLoginProvider mounts (see main.tsx), because its reducer snapshots
 * localStorage at mount and re-persists that snapshot on every state change —
 * a plaintext nsec seen at mount would keep getting rewritten.
 *
 * 1. MIGRATION — any login in localStorage[storageKey] with a plaintext
 *    `data.nsec` is captured into the in-memory session cache, encrypted into
 *    IndexedDB, and only THEN blanked from localStorage — persist-then-blank, so
 *    a crash mid-migration can never destroy the only copy of the key. main.tsx
 *    awaits this before React renders (or times out and leaves the plaintext in
 *    place for this boot). If the encrypted persist fails (e.g. IDB unavailable
 *    in some private-browsing modes) the plaintext is left untouched — an
 *    availability fallback mirroring the Tauri keychain-failure path — so a
 *    reload doesn't silently lock the user out, and the next boot retries.
 * 2. SCRUB — removes the stale copy of the login state that lib/idb.ts's
 *    one-time localStorage→IndexedDB migration placed in the `corkboard` kv
 *    store (it may contain a pre-migration plaintext nsec snapshot).
 * 3. RESTORE — warms the decrypt cache for already-blanked logins so the
 *    signer's first signature doesn't wait on IDB + WebCrypto. A missing or
 *    undecryptable record logs and yields null: that account then behaves as
 *    logged-out (signing fails with a clear error) instead of crashing.
 */
export async function prepareLoginStorage(storageKey: string): Promise<void> {
  // ── Synchronous phase: get plaintext out of localStorage NOW ──
  let raw: string | null = null;
  try { raw = localStorage.getItem(storageKey); } catch { return; }
  if (!raw) return;
  let state: unknown;
  try { state = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(state)) return;

  const plaintext: Array<{ pubkey: string; nsec: string }> = [];
  const blanked: string[] = [];
  for (const entry of state as PersistedLogin[]) {
    if (!entry || typeof entry.pubkey !== 'string') continue;
    const data = entry.data && typeof entry.data === 'object' ? entry.data : undefined;

    // NIP-46 bunker logins persist an ephemeral CLIENT key. Same treatment as
    // the identity key: capture it into the session cache, encrypt it, and
    // blank the localStorage copy only once the encrypted record commits.
    if (entry.type === 'bunker') {
      const id = bunkerClientSecretId(entry.pubkey);
      const clientNsec = data?.clientNsec;
      if (typeof clientNsec === 'string' && clientNsec !== '') {
        memNsec.set(id, clientNsec);
        plaintext.push({ pubkey: id, nsec: clientNsec });
      } else {
        blanked.push(id);
      }
      continue;
    }

    if (entry.type !== 'nsec') continue;
    const nsec = data?.nsec;
    if (typeof nsec === 'string' && nsec !== '') {
      memNsec.set(entry.pubkey, nsec); // keep the session alive regardless of persist outcome
      plaintext.push({ pubkey: entry.pubkey, nsec });
    } else {
      blanked.push(entry.pubkey);
    }
  }

  // ── Async phase ──
  // Scrub the stale kv-store copy of the login state (see docblock, step 2).
  try {
    const { idbRemove } = await import('./idb');
    await idbRemove(storageKey);
  } catch { /* best-effort */ }

  // Persist THEN blank. Encrypt each nsec into IndexedDB and only blank the
  // plaintext localStorage copy once its encrypted record has committed. The
  // previous order (blank synchronously, persist afterward) left a window where a
  // crash between the localStorage write and the IDB commit destroyed the ONLY
  // remaining copy of the key. main.tsx awaits this before mounting the login
  // provider — and on timeout leaves the plaintext in place for this boot — so
  // persisting first costs nothing and never risks the account. memNsec already
  // holds every key for the session, so a not-yet-committed account still signs,
  // and next boot retries the migration.
  const committed = new Set<string>();
  for (const { pubkey, nsec } of plaintext) {
    if (await storeNsec(pubkey, nsec)) committed.add(pubkey);
    else console.error(`[keystore] Could not encrypt nsec for ${pubkey.slice(0, 8)}… — leaving the legacy localStorage entry in place so the account survives reload`);
  }

  // Rewrite localStorage once, blanking only the entries whose encrypted record
  // committed. On failure the plaintext simply remains for the next boot to retry.
  if (committed.size > 0) {
    try {
      const cur = localStorage.getItem(storageKey);
      const curState: unknown = cur ? JSON.parse(cur) : state;
      if (Array.isArray(curState)) {
        for (const entry of curState as PersistedLogin[]) {
          if (typeof entry?.pubkey !== 'string' || !entry.data || typeof entry.data !== 'object') continue;
          if (entry.type === 'nsec' && committed.has(entry.pubkey)) {
            entry.data.nsec = '';
          } else if (entry.type === 'bunker' && committed.has(bunkerClientSecretId(entry.pubkey))) {
            entry.data.clientNsec = '';
          }
        }
        localStorage.setItem(storageKey, JSON.stringify(curState));
      }
    } catch { /* best-effort — plaintext remains and is retried next boot */ }
  }

  await Promise.all(blanked.map((pubkey) => loadNsec(pubkey)));
}

// Close the key-store connection on page unload (mirrors lib/idb.ts).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (db) {
      db.close();
      db = null;
      dbPromise = null;
    }
  });
}
