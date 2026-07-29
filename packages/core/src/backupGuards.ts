/**
 * The data-regression guards for the backup pipeline, as pure functions.
 *
 * These used to live inline in each platform's useNostrBackup, which meant the
 * web and mobile rules drifted and none of them were tested. The rules encode
 * one judgment, stated once:
 *
 *   A shrinking DISMISSED list is alarming — nobody "cleans up" dismissed
 *   notes, so a big drop means storage was partially cleared and saving now
 *   would overwrite a good cloud copy with a damaged one. Custom feeds
 *   dropping to zero is the same signal. A shrinking SAVED list is normal
 *   life — people clean out Save for Later — so it must never block a save
 *   or a merge; it only earns an informational heads-up.
 */

/** Item counts at last-backup time (persisted beside the snapshot). */
export interface BackupCounts {
  dismissed: number
  feeds: number
  collapsed: number
  bookmarks: number
}

/** A dismissed list this small can halve by ordinary use — not a signal. */
export const DISMISSED_REGRESSION_FLOOR = 20

export type AutoSaveGuardVerdict =
  | { action: 'proceed'; warning?: 'saved-cleanup' }
  | { action: 'block'; reason: 'dismissed-regressed' | 'feeds-zeroed'; detail: string }

/**
 * Should an auto-save proceed given how the data changed since the last one?
 *
 * Blocking is reserved for the storage-damage signals. A saved-notes cleanup
 * proceeds — blocking it was the bug where dismissing half your Save for
 * Later silently paused auto-save until a manual save.
 */
export function evaluateAutoSaveGuard(
  prev: BackupCounts,
  curr: BackupCounts,
): AutoSaveGuardVerdict {
  if (prev.dismissed > DISMISSED_REGRESSION_FLOOR && curr.dismissed < prev.dismissed * 0.5) {
    return {
      action: 'block',
      reason: 'dismissed-regressed',
      detail: `dismissed notes dropped from ${prev.dismissed} to ${curr.dismissed} — storage may be partially cleared`,
    }
  }
  if (prev.feeds > 0 && curr.feeds === 0) {
    return {
      action: 'block',
      reason: 'feeds-zeroed',
      detail: 'custom corkboards dropped to zero — storage may be partially cleared',
    }
  }

  const prevSaved = prev.collapsed + prev.bookmarks
  const currSaved = curr.collapsed + curr.bookmarks
  if (prevSaved > 10 && currSaved < prevSaved * 0.5) {
    return { action: 'proceed', warning: 'saved-cleanup' }
  }
  return { action: 'proceed' }
}

/** Stats carried in a backup manifest (all optional — old manifests lack some). */
export interface ManifestStats {
  savedForLater?: number
  dismissed?: number
}

/**
 * Is an incoming manifest suspiciously thin next to the newest one we know?
 *
 * Only a dismissed regression counts. The old rule also rejected manifests
 * with fewer saved notes, which made a legitimate Save-for-Later cleanup on
 * one device invisible to every other device — the cleaned-up backup was
 * discarded as "thin" and the stale one kept winning.
 */
export function evaluateManifestThinness(
  newest: ManifestStats | undefined,
  candidate: ManifestStats | undefined,
): 'ok' | 'dismissed-regressed' {
  const newestDismissed = newest?.dismissed ?? 0
  const candDismissed = candidate?.dismissed ?? 0
  if (newestDismissed > 50 && candDismissed < newestDismissed - 50) {
    return 'dismissed-regressed'
  }
  return 'ok'
}

/** Keys whose removals are routine cleanup, never a reason to hold a merge. */
const SAVED_CLEANUP_KEYS = new Set([
  'collapsed-notes',
  'nostr-bookmark-ids',
  'saved-minimized-notes',
])

export interface MergeHoldVerdict {
  hold: boolean
  reason?: 'dismissed-removals' | 'other-removals'
  /** Saved-note removals that will apply silently — callers toast when large. */
  savedCleanupCount: number
  /** Removals that count toward the hold decision. */
  guardedCount: number
}

/**
 * Should a pull-merge be held for user confirmation?
 *
 * `removals` is MergeResult.removals. Saved-for-later keys never hold —
 * "whatever the newest state is should be restored" — but their count is
 * returned so the caller can show the cleanup notice. Dismissed-note (and any
 * other guarded key's) removals beyond `silentLimit` still deserve a human.
 */
export function evaluateMergeHold(
  removals: { key: string; ids: string[] }[],
  silentLimit: number,
): MergeHoldVerdict {
  let savedCleanupCount = 0
  let dismissedCount = 0
  let otherCount = 0

  for (const { key, ids } of removals) {
    if (SAVED_CLEANUP_KEYS.has(key)) savedCleanupCount += ids.length
    else if (key === 'dismissed-notes' || key === 'dismissed-thread-roots') dismissedCount += ids.length
    else otherCount += ids.length
  }

  const guardedCount = dismissedCount + otherCount
  if (guardedCount > silentLimit) {
    return {
      hold: true,
      reason: dismissedCount >= otherCount ? 'dismissed-removals' : 'other-removals',
      savedCleanupCount,
      guardedCount,
    }
  }
  return { hold: false, savedCleanupCount, guardedCount }
}

/**
 * The blob and the manifest are written by the same save, so the blob's own
 * `savedAt` must sit at-or-before the manifest's claimed timestamp, within
 * the time a slow NIP-46 signer round-trip can put between them.
 */
export const BLOB_MANIFEST_MAX_SKEW_SECS = 15 * 60

/**
 * Does a downloaded backup blob actually belong to the manifest that named it?
 *
 * `blobSavedAt === 0` is a v4-format blob (no embedded timestamp) — accepted,
 * the hash check already proved integrity. Otherwise the blob may not claim a
 * time after the manifest, nor trail it by more than the skew allowance —
 * either way it is some other save's data and applying it as "the newest"
 * would silently roll the user back.
 */
export function verifyBlobMatchesManifest(
  blobSavedAt: number,
  manifestTimestampSecs: number,
): boolean {
  if (blobSavedAt === 0) return true
  return (
    blobSavedAt <= manifestTimestampSecs &&
    manifestTimestampSecs - blobSavedAt <= BLOB_MANIFEST_MAX_SKEW_SECS
  )
}
