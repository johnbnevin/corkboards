/**
 * Centralized cache TTL configuration.
 *
 * Every cache layer in the app reads its TTL from here so they can be
 * inspected and (in future) overridden from advanced settings.  Magic
 * numbers scattered across files made the system hard to reason about —
 * keep them in one place.
 *
 * All values are milliseconds.  Single-source export, no DI: these are
 * compile-time constants that the build inlines.
 */

/** How long a profile (kind 0) is considered fresh in IndexedDB before refetch. */
export const PROFILE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

/** How long a relay connection (NRelay1 instance) lives in the shared pool cache. */
export const RELAY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Per-event fetch cache (fetchEvent.ts) — how long a fetched event sticks around. */
export const FETCH_EVENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Notes cache eviction window — note not accessed within this falls out. */
export const NOTES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Auto-save minimum gap — don't trigger a backup more often than this. */
export const AUTO_SAVE_MIN_INTERVAL_MS = 30_000; // 30 seconds

/** Idle-return threshold — only fetch newer cloud backups if user was gone this long. */
export const IDLE_AUTO_RESTORE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Backup-checked flag — how long the "already checked this user" sticks. */
export const BACKUP_CHECKED_FLAG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * How often a device looks for a newer cloud snapshot while in the foreground.
 *
 * Shared by web (useCloudSync) and mobile (AutoSaveManager) so the two ends
 * cannot drift apart — a sync cadence is only meaningful as a pair.
 *
 * 60s matches what comparable schedule-based sync apps use (Standard Notes,
 * Bitwarden): poll on foreground plus a short interval, with only push-capable
 * apps going faster. One check is a single small relay query for one
 * addressable event. Paired with the 30s auto-save debounce, a change on one
 * device shows up on the other inside roughly a minute and a half worst case.
 */
export const CLOUD_SYNC_INTERVAL_MS = 60 * 1000;

/** Floor between two sync attempts however they were triggered — low enough
 *  that returning to the app feels immediate, high enough that app-switching
 *  cannot hammer the relays. */
export const CLOUD_SYNC_MIN_GAP_MS = 20 * 1000;
