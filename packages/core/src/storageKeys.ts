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

  // Media / bandwidth settings (shared)
  IMAGE_SIZE_LIMIT: 'corkboard:image-size-limit',
  AVATAR_SIZE_LIMIT: 'corkboard:avatar-size-limit',
  AUTOFETCH_INTERVAL_SECS: 'corkboard:autofetch-interval-secs',

  // Backup-related (not backed up themselves, local bookkeeping)
  LAST_BACKUP_TS: 'corkboard:last-backup-ts',
  LAST_CHUNK_COUNT: 'corkboard:last-chunk-count',
  BACKUP_CHECKED: 'corkboard:backup-checked',
  LAST_BACKUP_DATA: 'corkboard:last-backup-data',
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
  STORAGE_KEYS.FRIENDS,
  STORAGE_KEYS.BROWSE_RELAYS,
  STORAGE_KEYS.RSS_FEEDS,
  STORAGE_KEYS.SAVED_MINIMIZED_NOTES,
  STORAGE_KEYS.NWC,
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
    STORAGE_KEYS.LAST_BACKUP_DATA,
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
const ACTIVE_USER_KEY = 'corkboard:active-user-pubkey';

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
  for (const key of PER_USER_KEYS) {
    const value = storage.getSync(key);
    if (value !== null) {
      storage.setSync(`user:${pubkey}:${key}`, value);
    } else {
      storage.removeSync(`user:${pubkey}:${key}`);
    }
  }
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
  for (const key of PER_USER_KEYS) {
    const value = storage.getSync(`user:${pubkey}:${key}`);
    if (value !== null) {
      storage.setSync(key, value);
    } else {
      storage.removeSync(key);
    }
  }
}

/**
 * Switch active user: stash old user's data, restore new user's data.
 *
 * Pre-loads the new user's data before any destructive changes so the
 * clear-and-restore is safe even if storage reads fail mid-swap.
 */
export function switchActiveUser(storage: KVStorage, oldPubkey: string | null, newPubkey: string): void {
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
    }
  }

  storage.setSync(ACTIVE_USER_KEY, newPubkey);

  // Signal to backup system that this is an account switch, not a new session.
  // sessionStorage survives page reload but not new tabs/windows.
  try { sessionStorage.setItem('corkboard:account-switch', '1'); } catch { /* SSR / restricted */ }
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
  // Stash: read from sync cache (always current in an active session) and persist
  const stashOps = PER_USER_KEYS.map(async (key) => {
    const value = storage.getSync(key);
    if (value !== null) {
      await storage.set(`user:${pubkey}:${key}`, value);
    } else {
      await storage.remove(`user:${pubkey}:${key}`);
    }
  });
  await Promise.all(stashOps);

  // Clear all active per-user keys and the active-user marker
  const clearOps = [...PER_USER_KEYS.map(key => storage.remove(key)), storage.remove(ACTIVE_USER_KEY)];
  await Promise.all(clearOps);
}
