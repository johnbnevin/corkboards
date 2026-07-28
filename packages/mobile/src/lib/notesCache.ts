/**
 * Cleanup for two retired MMKV note caches.
 *
 * This file used to be a full two-level (memory + MMKV) note cache, and
 * `hooks/useFollowNotesCache.ts` was a second, independent one. Neither had a
 * single caller left: the app reads notes through React Query plus
 * `lib/cacheStore.ts` and `hooks/useCustomFeedNotesCache.ts`. The dead code was
 * not merely unused — it ran. Importing it kicked off a load that read every
 * `notes-cache:*` key and `JSON.parse`d up to 3000 events on the JS thread
 * during startup, for a cache nothing would ever read. And its rows kept sitting
 * in MMKV holding note bodies from whichever account wrote them.
 *
 * So the caches are gone and what remains is the removal of their rows.
 * `clearNotesCache` still exists because logout genuinely needs it: leftover
 * cached note bodies from account A must not survive into account B's session.
 */
import { mobileStorage } from '../storage/MmkvStorage';

/** Key prefixes written by the two retired caches. */
const RETIRED_PREFIXES = [
  'notes-cache:',
  'notes-meta:',
  'follow-notes-cache:',
];

const CLEANUP_FLAG = 'corkboard:retired-note-caches-cleared';

/**
 * Remove every row the retired caches left behind (L1 is gone with the code).
 *
 * Called on logout, where the point is that no note body from the departing
 * account can be read by the next one.
 */
export async function clearNotesCache(): Promise<void> {
  try {
    const allKeys = await mobileStorage.keys();
    for (const key of allKeys) {
      if (RETIRED_PREFIXES.some(prefix => key.startsWith(prefix))) {
        mobileStorage.removeSync(key);
      }
    }
  } catch (e) {
    console.warn('[notesCache] Failed to clear MMKV:', e instanceof Error ? e.message : e);
  }
}

/**
 * One-time reclaim on launch, so existing installs don't carry thousands of
 * orphaned note rows (and their content) around forever. Guarded by a flag so
 * it costs one key read per launch after the first.
 *
 * Fire-and-forget: nothing depends on the result, and a failure just means we
 * try again next launch.
 */
export function cleanupRetiredNoteCaches(): void {
  if (mobileStorage.getSync(CLEANUP_FLAG) === '1') return;
  void clearNotesCache()
    .then(() => { mobileStorage.setSync(CLEANUP_FLAG, '1'); })
    .catch(() => { /* retry next launch */ });
}
