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
  window.dispatchEvent(
    new CustomEvent('idb-storage-sync', { detail: { key, value } })
  );
}

// ─── Availability flag (false when IDB is unavailable, e.g. Safari private mode) ──
let idbAvailable = true;

// ─── IndexedDB open ──────────────────────────────────────────────────────────
let db: IDBDatabase | null = null;

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
  if (!db) {
    db = await openDb();
    // Invalidate cached handle if the browser closes the connection
    db.onclose = () => { db = null; };
    db.onerror = () => { db = null; };
  }
  return db;
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
  memCache.set(key, value);
  if (!idbAvailable) return;
  const database = await getDb();
  await wrapRequest(tx(database, 'readwrite').put(value, key));
  broadcastChange({ type: 'set', key, value });
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
  const store = tx(database, 'readonly');
  const keys = await wrapRequest<IDBValidKey[]>(store.getAllKeys());
  const values = await wrapRequest<string[]>(
    (await getDb()).transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
  );
  const map = new Map<string, string>();
  (keys as string[]).forEach((k, i) => map.set(k, values[i]));
  return map;
}

// ─── Sync cache accessors (available after idbReady) ─────────────────────────

/** Synchronous read from in-memory cache. Returns null if not loaded yet. */
export function idbGetSync(key: string): string | null {
  return memCache.get(key) ?? null;
}

/** Synchronous write – updates cache immediately and schedules IDB write. */
export function idbSetSync(key: string, value: string): void {
  // Skip caching large values to keep memCache bounded
  if (value.length <= 512_000) {
    if (memCache.size >= MAX_MEM_CACHE && !memCache.has(key)) {
      // Evict oldest entry
      memCache.delete(memCache.keys().next().value!);
    }
    memCache.set(key, value);
  }
  // Dispatch the sync event only after a confirmed IDB write so that
  // listeners don't act on data that was never actually persisted.
  idbSet(key, value).then(
    () => dispatchSyncEvent(key, tryParse(value)),
    (err) => console.warn('[idb] Failed to persist key', key, err),
  );
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
    db.onclose = () => { db = null; };
    db.onerror = () => { db = null; };

    await migrateFromLocalStorage(database);

    // Populate in-memory cache (skip large values that are only needed via async access)
    const all = await idbGetAll();
    const criticalKeys = ['nostr-custom-feeds', 'dismissed-notes', 'collapsed-notes', 'nostr-bookmark-ids'];
    for (const [k, v] of all) {
      // Custom feed caches can be megabytes of JSON — leave them in IDB only
      if (k.startsWith('custom-feed-cache:')) continue;
      // Backup snapshots duplicate all user data — not needed synchronously
      if (k === 'corkboard:last-backup-data') continue;
      // Safety net: skip any single value over 500KB
      if (v.length > 512_000) continue;
      memCache.set(k, v);
    }
    // Debug: log critical keys found in IDB at startup
    for (const k of criticalKeys) {
      const v = memCache.get(k);
      console.log(`[idb init] ${k}: ${v ? v.length + ' chars' : 'NOT FOUND'}`);
    }
    console.log(`[idb init] Total: ${all.size} keys in IDB, ${memCache.size} in memCache`);

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
