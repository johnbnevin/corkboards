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
 * History: an earlier attempt at a 30s pull (plus 10s poll / 10s debounce /
 * 15s floor, all running unconditionally) multiplied concurrent relay traffic
 * enough to regress working features — profile resolution slowed, nested-note
 * lookups starved, phone saves erroring mid-upload. What makes 30s safe now
 * is that it no longer runs unconditionally: after CLOUD_SYNC_IDLE_STRIKES
 * consecutive checks that found nothing new, checking STOPS until the app
 * comes back from idle (visible / focus / online / a local save). Steady-state
 * background traffic is therefore lower than the old always-on 60s loop, and
 * the push side is event-driven rather than a poll. The strike logic and this
 * interval are a unit — do not flip one without the other.
 */
export const CLOUD_SYNC_INTERVAL_MS = 30 * 1000;

/** Consecutive nothing-new checks before the pull loop goes quiet until the
 *  next back-from-idle signal. */
export const CLOUD_SYNC_IDLE_STRIKES = 3;

/** Floor between two sync attempts however they were triggered — low enough
 *  that returning to the app feels immediate, high enough that app-switching
 *  cannot hammer the relays. */
export const CLOUD_SYNC_MIN_GAP_MS = 20 * 1000;

/**
 * Auto-save (push) cadence — shared by web (useAutoSaveTrigger) and mobile
 * (AutoSaveManager). Push and pull cadences are a pair: the sync interval
 * above only converges devices as fast as the slower of the two.
 *
 * Detection is event-driven: the storage layer marks the backup dirty at the
 * write choke point (the same place tombstones are diffed), so a save costs
 * nothing until the user actually changes something.
 */
/** Safety-net poll only — catches any write path that somehow bypassed the
 *  dirty-marking choke point. Detection itself is event-driven. */
export const AUTO_SAVE_POLL_MS = 60 * 1000;
/** Trailing quiet window after the LAST change before uploading — each new
 *  write re-arms it, so a burst of edits becomes one upload. */
export const AUTO_SAVE_DEBOUNCE_MS = 3 * 1000;
/** Floor between two uploads. Each save is a blob to up to 3 Blossom servers
 *  plus a manifest publish. A fire landing inside the floor is DEFERRED to
 *  the floor's expiry, never dropped. */
export const AUTO_SAVE_MIN_INTERVAL_MS = 10 * 1000;
/** No auto-save for this long after launch — protects the cloud copy from
 *  being overwritten while local storage is still hydrating and the login
 *  backup check / auto-restore may still be in flight. */
export const AUTO_SAVE_STARTUP_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * A background sync merge may silently apply up to this many tombstone-driven
 * removals (items another device deliberately deleted). Beyond it, the merge
 * is held and the restore prompt is left standing for the user to confirm —
 * small deletions are routine sync traffic, a mass deletion deserves a human.
 * Holding is not free: while held, the local device must also not PUSH (its
 * snapshot still contains the deleted ids with a newer savedAt, which would
 * resurrect them on every other device), so the threshold keeps holds rare.
 */
export const SILENT_REMOVAL_LIMIT = 25;
