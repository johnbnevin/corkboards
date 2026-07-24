/**
 * IndexedDB storage backend for Corkboard.
 *
 * Provides:
 * - Async API (idbGet / idbSet / idbRemove / idbClear / idbKeys / idbGetAll)
 * - Synchronous in-memory cache populated after `idbReady` resolves
 * - BroadcastChannel for cross-tab cache invalidation
 * - One-time migration from localStorage on first run
 */

const DB_NAME = 'corkboard';
const STORE_NAME = 'kv';
const DB_VERSION = 1;
const MIGRATION_FLAG = '__idb_migrated_from_ls__';
const BROADCAST_CHANNEL_NAME = 'corkboard-idb';

// ─── In-memory sync cache ────────────────────────────────────────────────────
// Populated once after idbReady resolves so callers that need synchronous
// access (NostrProvider module-level init, backup serialise) can use it.
const MAX_MEM_CACHE = 2000;
const memCache = new Map<string, string>();

/**
 * Keys the cache is allowed to evict under pressure.
 *
 * `idbGetSync` is `memCache.get(key) ?? null` — it CANNOT tell "evicted" from
 * "absent on disk". Any caller that treats a null as "absent" and acts on it
 * destructively will delete live data. `stashUserData` (packages/core/src/
 * storageKeys.ts) does exactly that: on a null read it removes the user's
 * stashed copy of that key.
 *
 * So eviction is restricted to namespaces that are (a) unbounded in size, and
 * (b) only ever read through the ASYNC API, where a miss falls through to disk
 * and is harmless. `profile-cache:` is the one that actually grows without
 * limit — one entry per profile seen, so a few hundred follows pushes the cache
 * past MAX_MEM_CACHE within days.
 *
 * Everything else — app config, feeds, bookmarks, and every `user:<pubkey>:*`
 * stash — is pinned. Letting the cache exceed its target is strictly better
 * than silently reporting persisted user data as missing.
 */
const EVICTABLE_PREFIXES = ['profile-cache:', 'custom-feed-metadata:', 'relay-health:'];

function isEvictable(key: string): boolean {
  return EVICTABLE_PREFIXES.some((p) => key.startsWith(p));
}

let warnedCacheOverflow = false;

/**
 * Make room for `key` if the cache is at capacity, evicting only entries that
 * are safe to lose. Returns without evicting anything when nothing qualifies.
 */
function evictForNewKey(key: string): void {
  if (memCache.size < MAX_MEM_CACHE || memCache.has(key)) return;
  for (const candidate of memCache.keys()) {
    if (isEvictable(candidate)) {
      memCache.delete(candidate);
      return;
    }
  }
  // Nothing evictable: grow rather than drop a key a sync reader depends on.
  if (!warnedCacheOverflow) {
    warnedCacheOverflow = true;
    console.warn(
      `[idb] memCache exceeded ${MAX_MEM_CACHE} entries with no evictable keys; ` +
      'growing to keep synchronous reads correct.',
    );
  }
}

// ─── BroadcastChannel (cross-tab sync) ──────────────────────────────────────
let bc: BroadcastChannel | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (!bc) {
    try {
      bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    } catch {
      // Not supported in this environment
    }
  }
  return bc;
}

type BroadcastMessage =
  | { type: 'set'; key: string; value: string }
  | { type: 'remove'; key: string }
  | { type: 'clear' };

function broadcastChange(msg: BroadcastMessage): void {
  getBroadcastChannel()?.postMessage(msg);
}

// ─── Custom event for same-tab sync ─────────────────────────────────────────
// Mirrors the old 'local-storage-sync' event so useIdbStorage hooks update.
function dispatchSyncEvent(key: string, value: unknown): void {
  // Guarded: writes are scheduled asynchronously, so this can fire after the
  // document is gone — during teardown, or in any non-DOM context that imports
  // this module. An unhandled ReferenceError there would reject the write's
  // promise chain and look like a persistence failure.
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('idb-storage-sync', { detail: { key, value } })
  );
}

// ─── Availability flag (false when IDB is unavailable, e.g. Safari private mode) ──
let idbAvailable = true;

// ─── Persistence health tracking ────────────────────────────────────────────
// Tracks consecutive IDB write failures. When > 0, auto-save should avoid
// overwriting cloud backups because memCache data may not match disk.
let consecutiveWriteFailures = 0;
const MAX_WRITE_FAILURES_BEFORE_UNHEALTHY = 3;

/** Returns true if IDB writes are succeeding. Auto-save should check this. */
export function isIdbHealthy(): boolean {
  return idbAvailable && consecutiveWriteFailures < MAX_WRITE_FAILURES_BEFORE_UNHEALTHY;
}

// ─── IndexedDB open ──────────────────────────────────────────────────────────
let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) {
        d.createObjectStore(STORE_NAME);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getDb(): Promise<IDBDatabase> {
  if (db) return db;
  if (!dbPromise) {
    dbPromise = openDb().then(d => {
      db = d;
      db.onclose = () => { db = null; dbPromise = null; };
      db.onerror = () => { db = null; dbPromise = null; };
      return d;
    }).catch(err => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// ─── Core async helpers ───────────────────────────────────────────────────────

function tx(
  database: IDBDatabase,
  mode: IDBTransactionMode
): IDBObjectStore {
  return database.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key: string): Promise<string | null> {
  if (!idbAvailable) return memCache.get(key) ?? null;
  const database = await getDb();
  const result = await wrapRequest<string | undefined>(
    tx(database, 'readonly').get(key)
  );
  return result ?? null;
}

export async function idbSet(key: string, value: string): Promise<void> {
  if (!idbAvailable) {
    // In-memory-only mode: memCache *is* the store, so update it directly.
    memCache.set(key, value);
    return;
  }
  try {
    const database = await getDb();
    await wrapRequest(tx(database, 'readwrite').put(value, key));
    // Only mirror to memCache on confirmed disk success — prevents memCache
    // from diverging from disk when writes fail. Readers fall through to
    // idbGet (which reads disk) when a key isn't in memCache.
    memCache.set(key, value);
    consecutiveWriteFailures = 0;
    broadcastChange({ type: 'set', key, value });
  } catch {
    // Connection may have died — force reopen and retry once
    db = null;
    dbPromise = null;
    try {
      const database = await getDb();
      await wrapRequest(tx(database, 'readwrite').put(value, key));
      memCache.set(key, value);
      consecutiveWriteFailures = 0;
      broadcastChange({ type: 'set', key, value });
    } catch (retryErr) {
      consecutiveWriteFailures++;
      if (consecutiveWriteFailures === MAX_WRITE_FAILURES_BEFORE_UNHEALTHY) {
        console.error('[idb] Persistence unhealthy — IDB writes failing repeatedly. Auto-save will pause to protect cloud backups.');
      }
      throw retryErr;
    }
  }
}

export async function idbRemove(key: string): Promise<void> {
  memCache.delete(key);
  if (!idbAvailable) return;
  const database = await getDb();
  await wrapRequest(tx(database, 'readwrite').delete(key));
  broadcastChange({ type: 'remove', key });
}

export async function idbClear(): Promise<void> {
  memCache.clear();
  if (!idbAvailable) return;
  const database = await getDb();
  await wrapRequest(tx(database, 'readwrite').clear());
  // Close the connection so deleteDatabase() won't be blocked
  database.close();
  db = null;
  dbPromise = null;
  broadcastChange({ type: 'clear' });
}

export async function idbKeys(): Promise<string[]> {
  if (!idbAvailable) return [...memCache.keys()];
  const database = await getDb();
  const keys = await wrapRequest<IDBValidKey[]>(
    tx(database, 'readonly').getAllKeys()
  );
  return keys as string[];
}

export async function idbGetAll(): Promise<Map<string, string>> {
  if (!idbAvailable) return new Map(memCache);
  const database = await getDb();
  // Issue both reads on the SAME readonly transaction/store so keys and values
  // stay index-aligned. Reading them in two separate transactions let a write
  // commit in between and mismap keys→values, corrupting the cache. (M1)
  const store = tx(database, 'readonly');
  const [keys, values] = await Promise.all([
    wrapRequest<IDBValidKey[]>(store.getAllKeys()),
    wrapRequest<string[]>(store.getAll()),
  ]);
  const map = new Map<string, string>();
  (keys as string[]).forEach((k, i) => map.set(k, values[i]));
  return map;
}

// ─── Sync cache accessors (available after idbReady) ─────────────────────────

/** Synchronous read from in-memory cache. Returns null if not loaded yet. */
export function idbGetSync(key: string): string | null {
  return memCache.get(key) ?? null;
}

/**
 * Whether `key` is known to exist, answered authoritatively for every key the
 * sync cache is responsible for.
 *
 * `idbGetSync` returning null is NOT proof of absence, and callers that delete
 * on a null read (see `stashUserData` in packages/core/src/storageKeys.ts) need
 * proof. The cache is loaded with the complete key set at init and is only
 * allowed to evict the namespaces in EVICTABLE_PREFIXES, so for anything else
 * `memCache.has` is exact.
 *
 * Returns false — "cannot confirm absence" — for the two namespaces that are
 * deliberately kept out of the cache and for evictable keys, so a caller can
 * never turn a legitimate miss on those into a deletion.
 */
export function idbHasSync(key: string): boolean {
  if (memCache.has(key)) return true;
  const uncached =
    key.startsWith('custom-feed-cache:') ||
    key === 'corkboard:last-backup-data' ||
    isEvictable(key);
  // For uncached namespaces, claim existence so callers treat the key as
  // "present, value unknown" and leave it alone rather than deleting it.
  return uncached;
}

/** Synchronous write – updates cache immediately and schedules IDB write. */
export function idbSetSync(key: string, value: string): void {
  // Only skip memCache for the same blacklist used at init. A size threshold
  // here would create a sync/IDB read mismatch — idbGetSync would return null
  // for a value that exists on disk, silently breaking every reader.
  const skipCache = key.startsWith('custom-feed-cache:') || key === 'corkboard:last-backup-data';
  if (!skipCache) {
    evictForNewKey(key);
    memCache.set(key, value);
  }
  // Dispatch the sync event after IDB write (includes retry on failure).
  // If both attempts fail, data lives only in memCache until next successful write.
  idbSet(key, value).then(
    () => dispatchSyncEvent(key, tryParse(value)),
    (err) => console.warn('[idb] Failed to persist key (after retry)', key, err),
  );
}

/** Update the in-memory cache + notify readers WITHOUT scheduling a write.
 *  For bulk restore, which awaits its own single idbSet per key and needs to
 *  surface persistence failures instead of firing a second, unawaited write. */
export function idbPrimeCache(key: string, value: string): void {
  const skipCache = key.startsWith('custom-feed-cache:') || key === 'corkboard:last-backup-data';
  if (!skipCache) {
    evictForNewKey(key);
    memCache.set(key, value);
  }
  dispatchSyncEvent(key, tryParse(value));
}

/** Synchronous delete – removes from cache immediately and schedules IDB write. */
export function idbRemoveSync(key: string): void {
  memCache.delete(key);
  idbRemove(key).catch(console.warn);
  dispatchSyncEvent(key, null);
}

function tryParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

// ─── Migration from localStorage ─────────────────────────────────────────────
async function migrateFromLocalStorage(database: IDBDatabase): Promise<void> {
  // Check if migration has already run
  const flag = await wrapRequest<string | undefined>(
    database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(MIGRATION_FLAG)
  );
  if (flag) return; // already done

  // Collect keys/values first, then write in one transaction.
  // The flag is written last — if the transaction fails, no flag is set,
  // so the next init() retries the full migration (idempotent).
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }

  const txn = database.transaction(STORE_NAME, 'readwrite');
  const store = txn.objectStore(STORE_NAME);
  for (const [key, value] of entries) {
    store.put(value, key);
  }
  store.put('1', MIGRATION_FLAG); // flag is last — rollback on failure means no flag
  await new Promise<void>((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
    txn.onabort = () => reject(new Error('Migration transaction aborted'));
  });
  console.info('[idb] Migrated', entries.length, 'keys from localStorage → IndexedDB');
}

// ─── Initialisation ───────────────────────────────────────────────────────────

let _readyResolve: () => void;

/**
 * Promise that resolves once IndexedDB is open, migrated, and the in-memory
 * cache is populated — or once we've fallen back to in-memory-only mode.
 * Await this before using `idbGetSync`.
 */
export const idbReady: Promise<void> = new Promise((resolve) => {
  _readyResolve = resolve;
});

async function init(): Promise<void> {
  try {
    const database = await openDb();
    db = database;
    db.onclose = () => { db = null; dbPromise = null; };
    db.onerror = () => { db = null; dbPromise = null; };

    await migrateFromLocalStorage(database);

    // Populate in-memory cache. Only skip keys we *intentionally* never want
    // accessed synchronously — never use a size threshold, since user data
    // (e.g. nostr-custom-feeds) can legitimately grow past any cap and being
    // invisible to idbGetSync silently breaks every reader.
    const all = await idbGetAll();
    const criticalKeys = ['nostr-custom-feeds', 'dismissed-notes', 'collapsed-notes', 'nostr-bookmark-ids'];
    for (const [k, v] of all) {
      // Per-feed cached note bodies — fetched async only, can be megabytes each
      if (k.startsWith('custom-feed-cache:')) continue;
      // Backup snapshot duplicates all user data — only read at backup-time via async API
      if (k === 'corkboard:last-backup-data') continue;
      memCache.set(k, v);
    }
    // Debug: log critical keys found in IDB at startup (dev only — these key
    // names + sizes are user metadata and shouldn't ship to the prod console).
    if (import.meta.env.DEV) {
      for (const k of criticalKeys) {
        const v = memCache.get(k);
        console.log(`[idb init] ${k}: ${v ? v.length + ' chars' : 'NOT FOUND'}`);
      }
      console.log(`[idb init] Total: ${all.size} keys in IDB, ${memCache.size} in memCache`);
    }

    // Listen for cross-tab changes
    const channel = getBroadcastChannel();
    if (channel) {
      channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
        const msg = event.data;
        if (msg.type === 'set') {
          memCache.set(msg.key, msg.value);
          dispatchSyncEvent(msg.key, tryParse(msg.value));
        } else if (msg.type === 'remove') {
          memCache.delete(msg.key);
          dispatchSyncEvent(msg.key, null);
        } else if (msg.type === 'clear') {
          memCache.clear();
        }
      };
    }

    _readyResolve();
  } catch (err) {
    console.warn('[idb] IndexedDB unavailable — running with in-memory cache only (data will not persist across reloads):', err);
    idbAvailable = false;
    _readyResolve();
  }
}

// Start init immediately (module side-effect)
init();

// Close IndexedDB on page unload to prevent stale connections
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (db) {
      db.close();
      db = null;
    }
    if (bc) {
      bc.close();
      bc = null;
    }
  });
}
