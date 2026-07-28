/**
 * Centralized storage keys and user data isolation logic.
 *
 * Pure data definitions + functions that accept a KVStorage instance
 * so they work on any platform (web IndexedDB, Tauri, React Native MMKV).
 *
 * Settings are split into two categories:
 * - SHARED: content/account data, same across all platforms (feeds, friends, etc.)
 * - PLATFORM-SPECIFIC: layout/UX preferences that differ per device
 *   Stored with a platform prefix: "web:", "desktop:", "mobile:", "tablet:"
 *   Backed up with all platform variants so restore works on any device.
 */
import type { KVStorage } from './storage';

export type Platform = 'web' | 'desktop' | 'mobile' | 'tablet';

export const ALL_PLATFORMS: Platform[] = ['web', 'desktop', 'mobile', 'tablet'];

export const STORAGE_KEYS = {
  // Nostr-related (shared)
  CUSTOM_FEEDS: 'nostr-custom-feeds',
  COLLAPSED_NOTES: 'collapsed-notes',
  DISMISSED_NOTES: 'dismissed-notes',
  DISMISSED_THREAD_ROOTS: 'dismissed-thread-roots',
  FRIENDS: 'nostr-friends',
  BROWSE_RELAYS: 'nostr-browse-relays',
  RSS_FEEDS: 'nostr-rss-feeds',
  SAVED_MINIMIZED_NOTES: 'saved-minimized-notes',

  // Corkboard settings (shared)
  NWC: 'corkboard:nwc',
  SHOW_OWN_NOTES: 'corkboard:show-own-notes',
  ACTIVE_TAB: 'corkboard:active-tab',
  TAB_FILTERS: 'corkboard:tab-filters',
  PUBLIC_BOOKMARKS: 'corkboard:public-bookmarks',
  NOTIFICATIONS_LAST_SEEN: 'corkboard:notifications-last-seen',
  BLOCKED_RELAYS: 'corkboard:blocked-relays',
  BOOKMARK_IDS: 'nostr-bookmark-ids',
  PINNED_NOTE_IDS: 'nostr-pinned-note-ids',

  // Checkpoint metadata (Blossom backup history — discovered from relays, not backed up)
  REMOTE_CHECKPOINTS: 'corkboard:remote-checkpoints',

  // UI state (shared)
  TAB_BAR_COLLAPSED: 'corkboard:tab-bar-collapsed',
  STICKY_TAB_BAR: 'corkboard:sticky-tab-bar',
  FILTER_PANEL_COLLAPSED: 'filter-panel-collapsed',

  // Legacy filter keys (shared — content filtering rules apply everywhere)
  HIDE_MIN_CHARS: 'corkboard:hide-min-chars',
  HIDE_ONLY_EMOJI: 'corkboard:hide-only-emoji',
  ALLOW_PV: 'corkboard:allow-pv',
  ALLOW_GM: 'corkboard:allow-gm',
  ALLOW_GN: 'corkboard:allow-gn',
  ALLOW_EYES: 'corkboard:allow-eyes',
  ALLOW_100: 'corkboard:allow-100',
  HIDE_ONLY_MEDIA: 'corkboard:hide-only-media',
  HIDE_ONLY_LINKS: 'corkboard:hide-only-links',
  HIDE_HTML: 'corkboard:hide-html',
  HIDE_MARKDOWN: 'corkboard:hide-markdown',
  HIDE_EXACT_TEXT: 'corkboard:hide-exact-text',
  RENDER_MARKDOWN: 'corkboard:render-markdown',

  // Dialog geometry (platform-specific — different screen sizes per device)
  THREAD_DIALOG_GEOMETRY: 'corkboard:thread-dialog-geometry',
  COMPOSE_DIALOG_GEOMETRY: 'corkboard:compose-dialog-geometry',

  // Platform-specific keys (base names — actual storage uses platform prefix)
  DEFAULT_COLUMN_COUNT: 'corkboard:default-column-count',
  FEED_LIMIT_MULTIPLIER: 'corkboard:feed-limit-multiplier',
  AUTOFETCH: 'corkboard:autofetch',
  AUTOFETCH_SMALL: 'corkboard:autofetch-small',
  AUTO_CONSOLIDATE: 'corkboard:auto-consolidate',
  AUTO_SCROLL_TOP: 'corkboard:auto-scroll-top',
  LOAD_ALL_MEDIA: 'corkboard:load-all-media',
  LOAD_ALL_MEDIA_SMALL: 'corkboard:load-all-media-small',
  FILTERS_OPEN: 'corkboard:filters-open',
  PROFILE_CARD_COLLAPSED: 'profile-card-collapsed',

  // Banner display settings (shared — same preference across devices)
  BANNER_HEIGHT_PCT: 'corkboard:banner-height-pct',   // height as % of width; 0 = auto (natural aspect)
  BANNER_FIT_MODE: 'corkboard:banner-fit-mode',       // 'crop' | 'scale'

  // Onboarding (per-user — each account has its own onboarding state)
  ONBOARDING_SKIPPED: 'corkboard:onboarding-skipped',
  ONBOARDING_FOLLOW_TARGET: 'corkboard:onboarding-follow-target', // number: follow count to reach (default 10, set to current+10 on restart)

  // Blossom servers (per-user — different accounts may use different servers)
  BLOSSOM_SERVERS: 'corkboard:blossom-servers',
  // Watermark (created_at of the last-adopted kind-10063) for the Blossom server
  // list sync — per-user, local bookkeeping, NOT backed up.
  BLOSSOM_SERVERS_UPDATED_AT: 'corkboard:blossom-servers-updated-at',
  // Servers that rejected the backup-blob content type (HTTP 415). App-local
  // health state so backup saves skip them; NOT backed up (device/network-specific).
  BLOSSOM_BLOB_REJECTS: 'corkboard:blossom-blob-rejects',

  // Media / bandwidth settings (shared)
  IMAGE_SIZE_LIMIT: 'corkboard:image-size-limit',
  AVATAR_SIZE_LIMIT: 'corkboard:avatar-size-limit',
  AUTOFETCH_INTERVAL_SECS: 'corkboard:autofetch-interval-secs',

  // Backup-related (not backed up themselves, local bookkeeping)
  LAST_BACKUP_TS: 'corkboard:last-backup-ts',
  LAST_CHUNK_COUNT: 'corkboard:last-chunk-count',
  BACKUP_CHECKED: 'corkboard:backup-checked',
  // Round-robin cursor for the bounded manual-backup slot ring (keeps on-relay
  // backups capped instead of leaking one addressable event per manual save).
  BACKUP_SLOT_CURSOR: 'corkboard:backup-slot-cursor',
  LAST_BACKUP_DATA: 'corkboard:last-backup-data',
  LAST_BACKUP_HASHES: 'corkboard:last-backup-hashes',
  LAST_BACKUP_COUNTS: 'corkboard:last-backup-counts',
  RESTORE_HISTORY: 'corkboard:restore-history',
  // Persistent device identifier for cross-device sync (NOT backed up — stays local)
  DEVICE_ID: 'corkboard:device-id',
} as const;

/**
 * Keys whose values differ per platform (layout, density, UX).
 * Stored as `{platform}:{baseKey}` (e.g. "desktop:corkboard:default-column-count").
 * The unprefixed key is kept as a migration fallback.
 */
export const PLATFORM_SPECIFIC_KEYS = [
  STORAGE_KEYS.THREAD_DIALOG_GEOMETRY,
  STORAGE_KEYS.COMPOSE_DIALOG_GEOMETRY,
  STORAGE_KEYS.DEFAULT_COLUMN_COUNT,
  STORAGE_KEYS.FEED_LIMIT_MULTIPLIER,
  STORAGE_KEYS.AUTOFETCH,
  STORAGE_KEYS.AUTOFETCH_SMALL,
  STORAGE_KEYS.AUTO_CONSOLIDATE,
  STORAGE_KEYS.AUTO_SCROLL_TOP,
  STORAGE_KEYS.LOAD_ALL_MEDIA,
  STORAGE_KEYS.LOAD_ALL_MEDIA_SMALL,
  STORAGE_KEYS.FILTERS_OPEN,
  STORAGE_KEYS.PROFILE_CARD_COLLAPSED,
] as const;

/** Get the platform-prefixed storage key */
export function platformKey(platform: Platform, baseKey: string): string {
  return `${platform}:${baseKey}`;
}

/**
 * Read a platform-specific setting. Falls back to the unprefixed key
 * for migration from pre-platform storage.
 */
export function getPlatformSetting(storage: KVStorage, platform: Platform, baseKey: string): string | null {
  return storage.getSync(platformKey(platform, baseKey))
    ?? storage.getSync(baseKey);  // migration fallback
}

/**
 * Write a platform-specific setting.
 */
export function setPlatformSetting(storage: KVStorage, platform: Platform, baseKey: string, value: string): void {
  storage.setSync(platformKey(platform, baseKey), value);
}

/**
 * Remove a platform-specific setting.
 */
export function removePlatformSetting(storage: KVStorage, platform: Platform, baseKey: string): void {
  storage.removeSync(platformKey(platform, baseKey));
}

// ─── Shared keys (content/account, same across all platforms) ───────────────

const SHARED_BACKED_UP_KEYS = [
  STORAGE_KEYS.CUSTOM_FEEDS,
  STORAGE_KEYS.COLLAPSED_NOTES,
  STORAGE_KEYS.DISMISSED_NOTES,
  STORAGE_KEYS.DISMISSED_THREAD_ROOTS,
  STORAGE_KEYS.FRIENDS,
  STORAGE_KEYS.BROWSE_RELAYS,
  STORAGE_KEYS.RSS_FEEDS,
  STORAGE_KEYS.SAVED_MINIMIZED_NOTES,
  // NOTE: NWC (wallet connection) is intentionally NOT backed up. It is a
  // spending-capable secret and the settings backup is written UNENCRYPTED to
  // local disk / an optional Blossom blob; a wallet URI must never flow there.
  // (Today NWC is kept in React state only and never persisted, so this is also
  // a guard against a future change that starts persisting it.)
  STORAGE_KEYS.SHOW_OWN_NOTES,
  STORAGE_KEYS.ACTIVE_TAB,
  STORAGE_KEYS.TAB_FILTERS,
  STORAGE_KEYS.PUBLIC_BOOKMARKS,
  STORAGE_KEYS.NOTIFICATIONS_LAST_SEEN,
  STORAGE_KEYS.BLOCKED_RELAYS,
  STORAGE_KEYS.BOOKMARK_IDS,
  STORAGE_KEYS.PINNED_NOTE_IDS,
  // NOTE: REMOTE_CHECKPOINTS is intentionally NOT backed up — checkpoint metadata
  // is always discovered fresh from relays. Including it in backups caused stale
  // checkpoint lists to overwrite relay-discovered ones during restore.
  STORAGE_KEYS.TAB_BAR_COLLAPSED,
  STORAGE_KEYS.STICKY_TAB_BAR,
  STORAGE_KEYS.FILTER_PANEL_COLLAPSED,
  // Content filter rules apply everywhere
  STORAGE_KEYS.HIDE_MIN_CHARS,
  STORAGE_KEYS.HIDE_ONLY_EMOJI,
  STORAGE_KEYS.ALLOW_PV,
  STORAGE_KEYS.ALLOW_GM,
  STORAGE_KEYS.ALLOW_GN,
  STORAGE_KEYS.ALLOW_EYES,
  STORAGE_KEYS.ALLOW_100,
  STORAGE_KEYS.HIDE_ONLY_MEDIA,
  STORAGE_KEYS.HIDE_ONLY_LINKS,
  STORAGE_KEYS.HIDE_HTML,
  STORAGE_KEYS.HIDE_MARKDOWN,
  STORAGE_KEYS.HIDE_EXACT_TEXT,
  STORAGE_KEYS.RENDER_MARKDOWN,
  STORAGE_KEYS.ONBOARDING_SKIPPED,
  STORAGE_KEYS.ONBOARDING_FOLLOW_TARGET,
  STORAGE_KEYS.BANNER_HEIGHT_PCT,
  STORAGE_KEYS.BANNER_FIT_MODE,
  STORAGE_KEYS.BLOSSOM_SERVERS,
  STORAGE_KEYS.IMAGE_SIZE_LIMIT,
  STORAGE_KEYS.AVATAR_SIZE_LIMIT,
  STORAGE_KEYS.AUTOFETCH_INTERVAL_SECS,
];

/**
 * All keys that go into a backup. Includes shared keys (unprefixed)
 * plus all platform variants of platform-specific keys.
 */
export function getAllBackupKeys(): string[] {
  const keys: string[] = [...SHARED_BACKED_UP_KEYS];
  for (const baseKey of PLATFORM_SPECIFIC_KEYS) {
    // Include unprefixed for backward compat
    keys.push(baseKey);
    // Include all platform variants
    for (const p of ALL_PLATFORMS) {
      keys.push(platformKey(p, baseKey));
    }
  }
  return keys;
}

/** Backward-compatible flat list for code that still uses BACKED_UP_KEYS directly */
export const BACKED_UP_KEYS = getAllBackupKeys();

// ─── Per-user key isolation ─────────────────────────────────────────────────

/** All keys that are isolated per user account (shared + all platform variants) */
function getAllPerUserKeys(): string[] {
  const keys: string[] = [
    ...SHARED_BACKED_UP_KEYS,
    STORAGE_KEYS.REMOTE_CHECKPOINTS, // per-user but not backed up (discovered from relays)
    STORAGE_KEYS.LAST_BACKUP_TS,
    STORAGE_KEYS.LAST_CHUNK_COUNT,
    STORAGE_KEYS.BACKUP_SLOT_CURSOR, // per-user local bookkeeping (not backed up)
    STORAGE_KEYS.BLOSSOM_BLOB_REJECTS, // per-user server-health state (not backed up)
    STORAGE_KEYS.BLOSSOM_SERVERS_UPDATED_AT, // per-user sync watermark (not backed up)
    STORAGE_KEYS.LAST_BACKUP_DATA,
    STORAGE_KEYS.LAST_BACKUP_HASHES,
    STORAGE_KEYS.LAST_BACKUP_COUNTS,
    STORAGE_KEYS.RESTORE_HISTORY,
  ];
  for (const baseKey of PLATFORM_SPECIFIC_KEYS) {
    keys.push(baseKey); // unprefixed (migration)
    for (const p of ALL_PLATFORMS) {
      keys.push(platformKey(p, baseKey));
    }
  }
  return keys;
}

export const PER_USER_KEYS = getAllPerUserKeys();

// Track which pubkey currently owns the active (global) keys
export const ACTIVE_USER_KEY = 'corkboard:active-user-pubkey';

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/** Validate that a pubkey is a 64-char lowercase hex string. Throws on invalid input. */
function assertValidPubkey(pubkey: string): void {
  if (!PUBKEY_RE.test(pubkey)) {
    throw new Error(`Invalid pubkey: expected 64-char hex, got "${pubkey.slice(0, 16)}..."`);
  }
}

/**
 * Save the current global per-user keys into namespaced storage for the given pubkey.
 */
export function stashUserData(storage: KVStorage, pubkey: string): void {
  assertValidPubkey(pubkey);
  // Snapshot EVERY value before writing anything.
  //
  // The interleaved read-modify-write this replaces was self-defeating on web
  // and desktop: `getSync`/`setSync` are backed by an in-memory cache
  // (packages/web/src/lib/idb.ts) that evicts an entry whenever a NEW key is
  // added at capacity — and this loop adds ~90 new `user:<pubkey>:*` keys. So
  // writes made early in the loop evicted keys the loop had not read yet,
  // later `getSync` calls returned null for data that was sitting on disk, and
  // the `else` branch below turned each of those misses into a `removeSync`
  // that DELETED the user's stashed copy. Reading first makes the loop's own
  // writes unable to perturb what it reads.
  const snapshot: Array<[string, string | null]> = PER_USER_KEYS.map(
    (key) => [key, storage.getSync(key)],
  );
  for (const [key, value] of snapshot) {
    if (value !== null) {
      storage.setSync(`user:${pubkey}:${key}`, value);
    } else if (isConfirmedAbsent(storage, key)) {
      // Only drop the stashed copy when the live key is genuinely gone — see
      // isConfirmedAbsent. A cache miss must never be read as a deletion.
      storage.removeSync(`user:${pubkey}:${key}`);
    } else {
      // Present but unreadable synchronously. `corkboard:last-backup-data` is
      // the standing example: it is in PER_USER_KEYS but deliberately kept out
      // of web's sync cache (it duplicates every other key and is only read at
      // backup time), so `getSync` returns null for it on EVERY switch. The old
      // code took that null as "absent" and deleted the departing account's
      // stashed backup snapshot every single time — not a race, a certainty.
      // Copy it through the async API instead.
      copyThroughAsync(storage, key, `user:${pubkey}:${key}`);
    }
  }
}

/**
 * Mirror `from` → `to` using the async API, for keys the sync cache can't read.
 *
 * Fire-and-forget by design: the account swap must not block on it, and the
 * value is never needed synchronously afterwards. Failures are swallowed
 * because the alternative — deleting or clobbering the destination — is what
 * this exists to avoid; leaving the previous stashed value in place is the safe
 * outcome.
 */
function copyThroughAsync(storage: KVStorage, from: string, to: string): void {
  void storage
    .get(from)
    .then((value) => (value === null ? undefined : storage.set(to, value)))
    .catch(() => { /* keep the existing stashed value */ });
}

/**
 * True only when `key` is known NOT to exist in the backing store.
 *
 * Returns false when we cannot tell — a `getSync` miss on a cache-backed
 * store means "not cached", which is not the same as "not stored". Callers use
 * this to decide whether a null read justifies a DELETE; when in doubt the
 * answer must be "no", because leaving a stale value behind is recoverable and
 * deleting the user's only copy is not.
 */
function isConfirmedAbsent(storage: KVStorage, key: string): boolean {
  return typeof storage.hasSync === 'function' ? !storage.hasSync(key) : false;
}

/**
 * Clear all global per-user keys (wipe the active session data).
 */
export function clearActiveUserData(storage: KVStorage): void {
  for (const key of PER_USER_KEYS) {
    storage.removeSync(key);
  }
}

/**
 * Restore a user's namespaced data into the global per-user keys.
 */
export function restoreUserData(storage: KVStorage, pubkey: string): void {
  assertValidPubkey(pubkey);
  // Snapshot before writing, for the same reason as stashUserData above: this
  // loop's own writes must not be able to evict the entries it has yet to read.
  const snapshot: Array<[string, string | null]> = PER_USER_KEYS.map(
    (key) => [key, storage.getSync(`user:${pubkey}:${key}`)],
  );
  for (const [key, value] of snapshot) {
    if (value !== null) {
      storage.setSync(key, value);
    } else if (isConfirmedAbsent(storage, `user:${pubkey}:${key}`)) {
      // The incoming account genuinely has no value for this key, so the live
      // key must be cleared rather than leaking the previous account's value.
      storage.removeSync(key);
    } else {
      // Stashed but not synchronously readable (see stashUserData). Clear the
      // live key first so the previous account's value can't be read in the
      // gap, then restore this account's copy asynchronously.
      storage.removeSync(key);
      copyThroughAsync(storage, `user:${pubkey}:${key}`, key);
    }
  }
}

/**
 * Switch active user: stash old user's data, restore new user's data.
 *
 * Pre-loads the new user's data before any destructive changes so the
 * clear-and-restore is safe even if storage reads fail mid-swap.
 */
export function switchActiveUser(
  storage: KVStorage,
  oldPubkey: string | null,
  newPubkey: string,
  // Platform-supplied hook fired after a successful swap (e.g. web records an
  // ephemeral "account-switch" flag in sessionStorage). Kept out of core so
  // this module stays DOM-free and the hook can't silently no-op on mobile.
  onSwitch?: () => void,
): void {
  assertValidPubkey(newPubkey);
  if (oldPubkey) assertValidPubkey(oldPubkey);
  if (oldPubkey === newPubkey) return;

  // Pre-load new user's data before making any destructive changes.
  const newUserData = new Map<string, string | null>();
  for (const key of PER_USER_KEYS) {
    newUserData.set(key, storage.getSync(`user:${newPubkey}:${key}`));
  }

  if (oldPubkey) {
    stashUserData(storage, oldPubkey);
  }

  // Clear then restore using pre-loaded snapshot — atomic-like swap.
  for (const key of PER_USER_KEYS) {
    storage.removeSync(key);
  }
  for (const [key, value] of newUserData) {
    if (value !== null) {
      storage.setSync(key, value);
    } else if (!isConfirmedAbsent(storage, `user:${newPubkey}:${key}`)) {
      // Stashed but not synchronously readable (e.g. `corkboard:last-backup-data`,
      // deliberately kept out of web's sync cache). Without this branch the key was
      // cleared above and never restored — silently dropping the incoming account's
      // backup baseline on every switch. Mirror restoreUserData: the live key is
      // already cleared, so copy this account's stashed value through the async API.
      copyThroughAsync(storage, `user:${newPubkey}:${key}`, key);
    }
    // else: genuinely absent for the incoming account — leave the live key cleared.
  }

  storage.setSync(ACTIVE_USER_KEY, newPubkey);

  // Signal to the platform that this was an account switch, not a new session.
  onSwitch?.();
}

/**
 * Get the pubkey of the user who currently owns the active keys.
 */
export function getActiveUserPubkey(storage: KVStorage): string | null {
  return storage.getSync(ACTIVE_USER_KEY);
}

/**
 * Handle logout: stash the user's data and clear active keys.
 */
export function handleLogoutStorage(storage: KVStorage, pubkey: string): void {
  assertValidPubkey(pubkey);
  stashUserData(storage, pubkey);
  clearActiveUserData(storage);
  storage.removeSync(ACTIVE_USER_KEY);
  // Rotate device ID on logout to prevent cross-session tracking
  storage.removeSync(STORAGE_KEYS.DEVICE_ID);
}

/**
 * Async version of handleLogoutStorage — awaits all IndexedDB writes so they
 * complete before a page reload, preventing stale data from leaking to the
 * next logged-in user.
 */
export async function handleLogoutStorageAsync(storage: KVStorage, pubkey: string): Promise<void> {
  assertValidPubkey(pubkey);
  // Stash by reading each key AUTHORITATIVELY from the backing store, not the sync
  // cache. `getSync` returns null for keys deliberately excluded from web's
  // memCache — `corkboard:last-backup-data` on EVERY call — and the old code took
  // that null as "absent" and deleted the departing account's stashed backup
  // snapshot on every logout (a certainty, not a race; the sync stash path guards
  // against exactly this). `await storage.get` reads disk, so a null here means the
  // value is genuinely gone and removing the stash copy is correct.
  const stashOps = PER_USER_KEYS.map(async (key) => {
    const value = await storage.get(key);
    if (value !== null) {
      await storage.set(`user:${pubkey}:${key}`, value);
    } else {
      await storage.remove(`user:${pubkey}:${key}`);
    }
  });
  await Promise.all(stashOps);

  // Clear all active per-user keys and the active-user marker, and rotate the
  // device ID (parity with the sync handleLogoutStorage) to prevent
  // cross-session tracking after the post-logout reload.
  const clearOps = [
    ...PER_USER_KEYS.map(key => storage.remove(key)),
    storage.remove(ACTIVE_USER_KEY),
    storage.remove(STORAGE_KEYS.DEVICE_ID),
  ];
  await Promise.all(clearOps);
}
