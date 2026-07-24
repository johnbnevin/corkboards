/**
 * Regression tests for per-account data isolation in @core/storageKeys.
 *
 * The bug these pin: on web/desktop `getSync` reads an in-memory cache that
 * evicts entries when new keys are added at capacity. `stashUserData` both READ
 * and WROTE inside one loop, so its own ~90 writes evicted keys it had not read
 * yet; the resulting null reads were treated as "absent" and turned into
 * `removeSync` calls that deleted the departing account's stashed settings.
 * Switching back then found nothing to restore and cleared the live keys too.
 */
import { describe, it, expect } from 'vitest';
import type { KVStorage } from '@core/storage';
import { stashUserData, restoreUserData, switchActiveUser, PER_USER_KEYS } from '@core/storageKeys';

const USER_A = 'a'.repeat(64);
const USER_B = 'b'.repeat(64);

/**
 * Storage whose synchronous cache evicts like the real IndexedDB backend:
 * adding a NEW key at capacity drops the oldest cached entry, while the value
 * stays on "disk". `getSync` therefore returns null for evicted-but-present
 * keys — the exact ambiguity that caused the data loss.
 */
function evictingStorage(capacity: number): KVStorage & { disk: Map<string, string> } {
  const disk = new Map<string, string>();
  const cache = new Map<string, string>();

  const cacheSet = (key: string, value: string) => {
    if (cache.size >= capacity && !cache.has(key)) {
      cache.delete(cache.keys().next().value!);
    }
    cache.set(key, value);
  };

  return {
    disk,
    getSync: (key) => cache.get(key) ?? null,
    // Existence is answered from disk, which is what makes a null getSync
    // recoverable: the helpers can tell "evicted" from "deleted".
    hasSync: (key) => disk.has(key),
    setSync: (key, value) => { disk.set(key, value); cacheSet(key, value); },
    removeSync: (key) => { disk.delete(key); cache.delete(key); },
    get: async (key) => disk.get(key) ?? null,
    set: async (key, value) => { disk.set(key, value); cacheSet(key, value); },
    remove: async (key) => { disk.delete(key); cache.delete(key); },
    clear: async () => { disk.clear(); cache.clear(); },
    keys: async () => [...disk.keys()],
    getAll: async () => new Map(disk),
    ready: Promise.resolve(),
  };
}

/** Seed every per-user key with a distinguishable value, warming the cache. */
function seedAllKeys(storage: KVStorage): Map<string, string> {
  const written = new Map<string, string>();
  for (const key of PER_USER_KEYS) {
    const value = `value-for-${key}`;
    storage.setSync(key, value);
    written.set(key, value);
  }
  return written;
}

/** Let the fire-and-forget async copies in stash/restore settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('stashUserData', () => {
  it('stashes every key when the cache holds them all (the real contract)', () => {
    const storage = evictingStorage(10_000);
    const expected = seedAllKeys(storage);

    stashUserData(storage, USER_A);

    for (const [key, value] of expected) {
      expect(storage.disk.get(`user:${USER_A}:${key}`)).toBe(value);
    }
  });

  it('NEVER deletes a stashed value just because the live key is uncached', async () => {
    // The destructive half of the bug. Capacity far below the key count means
    // most live keys are on disk but evicted from the sync cache, so `getSync`
    // returns null for them. That must not be read as "the user deleted this".
    const storage = evictingStorage(8);
    const expected = seedAllKeys(storage);

    stashUserData(storage, USER_A);
    await flush(); // the uncached keys are copied through the async API

    for (const [key, value] of expected) {
      expect(storage.disk.get(`user:${USER_A}:${key}`)).toBe(value);
    }
  });

  it('still removes a stashed key that is genuinely absent', () => {
    // Correctness in the other direction: a key the user really does not have
    // must not linger in their stash from a previous session.
    const storage = evictingStorage(10_000);
    const [firstKey] = PER_USER_KEYS;
    storage.setSync(`user:${USER_A}:${firstKey}`, 'stale');
    stashUserData(storage, USER_A);
    expect(storage.disk.get(`user:${USER_A}:${firstKey}`)).toBeUndefined();
  });

  it('preserves a stash when absence cannot be confirmed at all', () => {
    // A backend without hasSync (the optional half of KVStorage) can never
    // prove absence, so the helpers must fall back to leaving data alone.
    const storage = evictingStorage(10_000) as ReturnType<typeof evictingStorage> & { hasSync?: unknown };
    delete storage.hasSync;
    const [firstKey] = PER_USER_KEYS;
    storage.disk.set(`user:${USER_A}:${firstKey}`, 'precious');
    stashUserData(storage, USER_A);
    expect(storage.disk.get(`user:${USER_A}:${firstKey}`)).toBe('precious');
  });
});

describe('restoreUserData', () => {
  it('restores every stashed key', () => {
    const storage = evictingStorage(10_000);
    const expected = new Map<string, string>();
    for (const key of PER_USER_KEYS) {
      const value = `stashed-${key}`;
      storage.setSync(`user:${USER_A}:${key}`, value);
      expected.set(key, value);
    }

    restoreUserData(storage, USER_A);

    for (const [key, value] of expected) {
      expect(storage.disk.get(key)).toBe(value);
    }
  });

  it('recovers uncached stashed values through the async path', async () => {
    const storage = evictingStorage(8);
    const expected = new Map<string, string>();
    for (const key of PER_USER_KEYS) {
      const value = `stashed-${key}`;
      storage.setSync(`user:${USER_A}:${key}`, value);
      expected.set(key, value);
    }

    restoreUserData(storage, USER_A);
    await flush();

    for (const [key, value] of expected) {
      expect(storage.disk.get(key)).toBe(value);
    }
  });
});

describe('switchActiveUser round trip', () => {
  it('keeps both accounts intact across a switch and back', async () => {
    const storage = evictingStorage(10_000);
    const aData = seedAllKeys(storage);

    switchActiveUser(storage, USER_A, USER_B);
    await flush();
    for (const key of PER_USER_KEYS) {
      expect(storage.disk.get(`user:${USER_A}:${key}`)).toBe(aData.get(key));
    }

    const bData = new Map<string, string>();
    for (const key of PER_USER_KEYS) {
      const value = `b-value-for-${key}`;
      storage.setSync(key, value);
      bData.set(key, value);
    }
    switchActiveUser(storage, USER_B, USER_A);
    await flush();

    // A's settings are live again…
    for (const key of PER_USER_KEYS) {
      expect(storage.disk.get(key)).toBe(aData.get(key));
    }
    // …and B's are safely stashed, not clobbered by the swap.
    for (const key of PER_USER_KEYS) {
      expect(storage.disk.get(`user:${USER_B}:${key}`)).toBe(bData.get(key));
    }
  });
});

describe('the sync cache pins keys these helpers depend on', () => {
  it('never evicts a per-user key, only the unbounded caches', async () => {
    // This is the property that lets the sync path stay correct. If a future
    // change makes app-state keys evictable again, the helpers go back to
    // reading live data as absent — so assert the policy directly.
    const { idbSetSync, idbGetSync, idbGet, idbReady } = await import('@/lib/idb');
    await idbReady;

    for (const key of PER_USER_KEYS) {
      if (key === 'corkboard:last-backup-data') continue; // intentionally uncached
      idbSetSync(key, `v-${key}`);
    }
    // Push well past MAX_MEM_CACHE with evictable entries.
    for (let i = 0; i < 2500; i++) idbSetSync(`profile-cache:${i}`, 'x');

    for (const key of PER_USER_KEYS) {
      if (key === 'corkboard:last-backup-data') continue;
      expect(idbGetSync(key)).toBe(`v-${key}`);
    }

    // idbSetSync schedules its IDB write without awaiting it. Drain the queue
    // before the test ends — IndexedDB serialises transactions, so a read
    // issued now resolves only after every write above has committed.
    await idbGet('profile-cache:2499');
  });
});
