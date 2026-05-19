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
