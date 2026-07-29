/**
 * The keys watched for backup change detection — shared by web and mobile.
 *
 * This list is what `hasUnsavedChanges()` hashes, what the auto-save
 * regression guard counts, and what the storage layer's dirty-marking watches
 * to arm the save debounce. A key missing from it is a key whose changes
 * never trigger a backup: web and mobile each kept their own copy and
 * mobile's had drifted four keys behind (bookmarks, dismissed thread roots,
 * pins, markdown pref), so edits to those on mobile never saved.
 *
 * Not every BACKED_UP_KEY belongs here — this is the "user data whose loss
 * hurts" subset. Layout and cosmetic keys still ride along in a backup once
 * one happens; they just don't cause one.
 */

import { STORAGE_KEYS } from './storageKeys'

export const SNAPSHOT_KEYS: readonly string[] = [
  STORAGE_KEYS.CUSTOM_FEEDS,
  STORAGE_KEYS.COLLAPSED_NOTES,
  STORAGE_KEYS.DISMISSED_NOTES,
  STORAGE_KEYS.DISMISSED_THREAD_ROOTS,
  STORAGE_KEYS.FRIENDS,
  STORAGE_KEYS.BROWSE_RELAYS,
  STORAGE_KEYS.RSS_FEEDS,
  STORAGE_KEYS.SAVED_MINIMIZED_NOTES,
  STORAGE_KEYS.BOOKMARK_IDS,
  STORAGE_KEYS.PINNED_NOTE_IDS,
  STORAGE_KEYS.TAB_FILTERS,
  STORAGE_KEYS.ONBOARDING_SKIPPED,
  STORAGE_KEYS.BANNER_HEIGHT_PCT,
  STORAGE_KEYS.BANNER_FIT_MODE,
  STORAGE_KEYS.RENDER_MARKDOWN,
]

const SNAPSHOT_KEY_SET = new Set<string>(SNAPSHOT_KEYS)

/** True when a write to this key should mark the backup dirty. */
export function isSnapshotKey(key: string): boolean {
  return SNAPSHOT_KEY_SET.has(key)
}
