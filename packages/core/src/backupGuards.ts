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
  corkboards?: number
  savedForLater?: number
  dismissed?: number
}

/**
 * Is an incoming manifest suspiciously thin next to the newest one we know?
 *
 * Dismissed regressing counts, same as always. So does corkboards regressing:
 * unlike a dismissed or saved-for-later count, which moves by the dozens in
 * ordinary use, a corkboard is hand-curated and there are only ever a few —
 * losing even one is a real, usually-unintended loss, not routine churn. A
 * saved-for-later regression alone still does NOT count — that's the one
 * that's normal to shrink (a cleanup), and treating it as thin was the bug
 * that made a legitimate cleanup invisible to every other device.
 */
export function evaluateManifestThinness(
  newest: ManifestStats | undefined,
  candidate: ManifestStats | undefined,
): 'ok' | 'dismissed-regressed' | 'corkboards-regressed' {
  const newestDismissed = newest?.dismissed ?? 0
  const candDismissed = candidate?.dismissed ?? 0
  if (newestDismissed > 50 && candDismissed < newestDismissed - 50) {
    return 'dismissed-regressed'
  }
  const newestCorkboards = newest?.corkboards ?? 0
  const candCorkboards = candidate?.corkboards ?? 0
  if (newestCorkboards > 0 && candCorkboards < newestCorkboards) {
    return 'corkboards-regressed'
  }
  return 'ok'
}

/** Keys whose removals are routine cleanup, never a reason to hold a merge. */
const SAVED_CLEANUP_KEYS = new Set([
  'collapsed-notes',
  'nostr-bookmark-ids',
  'saved-minimized-notes',
])

/**
 * Keys whose removals ALWAYS hold, however few — the numeric `silentLimit`
 * below is sized for routine note-id churn (dozens of dismissals a day is
 * normal). Corkboards are the opposite: there are only ever a handful, each
 * one hand-built, and losing even one is exactly the kind of loss a human
 * should confirm rather than a merge silently applying because it happened
 * to stay under a threshold sized for a completely different kind of data.
 */
const ALWAYS_HOLD_KEYS = new Set([
  'nostr-custom-feeds',
])

export interface MergeHoldVerdict {
  hold: boolean
  reason?: 'dismissed-removals' | 'other-removals' | 'corkboards-removed'
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
 * returned so the caller can show the cleanup notice. ANY corkboard removal
 * holds regardless of count. Dismissed-note (and any other guarded key's)
 * removals beyond `silentLimit` still deserve a human.
 */
export function evaluateMergeHold(
  removals: { key: string; ids: string[] }[],
  silentLimit: number,
): MergeHoldVerdict {
  let savedCleanupCount = 0
  let dismissedCount = 0
  let otherCount = 0
  let corkboardCount = 0

  for (const { key, ids } of removals) {
    if (SAVED_CLEANUP_KEYS.has(key)) savedCleanupCount += ids.length
    else if (ALWAYS_HOLD_KEYS.has(key)) corkboardCount += ids.length
    else if (key === 'dismissed-notes' || key === 'dismissed-thread-roots') dismissedCount += ids.length
    else otherCount += ids.length
  }

  const guardedCount = dismissedCount + otherCount + corkboardCount
  if (corkboardCount > 0) {
    return { hold: true, reason: 'corkboards-removed', savedCleanupCount, guardedCount }
  }
  if (dismissedCount + otherCount > silentLimit) {
    return {
      hold: true,
      reason: dismissedCount >= otherCount ? 'dismissed-removals' : 'other-removals',
      savedCleanupCount,
      guardedCount,
    }
  }
  return { hold: false, savedCleanupCount, guardedCount }
}

/** One candidate manifest, for choosing among several found for the same account. */
export interface ManifestCandidate {
  id: string
  timestamp: number
  stats?: ManifestStats
}

/**
 * Choose the most complete candidate among several manifests, for the one
 * moment picking by wall-clock `created_at` alone is unsafe: the FIRST
 * restore on a device with nothing local yet to sanity-check the clock-pick
 * against. A manifest that is merely a later SAVE (clock skew between
 * devices, or a save that raced a richer one) can otherwise permanently
 * outrank a far more complete backup.
 *
 * Corkboards weigh most (few, hand-curated, effectively impossible to
 * reconstruct from memory), then combined saved+dismissed count, then
 * recency as the final tiebreaker — so this agrees with the plain
 * newest-by-timestamp pick whenever there is nothing to disagree about.
 */
export function pickRichestManifest<T extends ManifestCandidate>(candidates: readonly T[]): T {
  if (candidates.length === 0) throw new Error('pickRichestManifest: no candidates')
  return candidates.reduce((best, cand) => {
    const bestCorkboards = best.stats?.corkboards ?? 0
    const candCorkboards = cand.stats?.corkboards ?? 0
    if (candCorkboards !== bestCorkboards) return candCorkboards > bestCorkboards ? cand : best
    const bestBulk = (best.stats?.savedForLater ?? 0) + (best.stats?.dismissed ?? 0)
    const candBulk = (cand.stats?.savedForLater ?? 0) + (cand.stats?.dismissed ?? 0)
    if (candBulk !== bestBulk) return candBulk > bestBulk ? cand : best
    return cand.timestamp > best.timestamp ? cand : best
  })
}

/** The fields checkpoint retention needs — platforms extend this shape. */
export interface CheckpointEntry {
  eventId: string
  timestamp: number
  name?: string
  stats?: ManifestStats
}

/** How many unnamed checkpoints survive a trim (matches the "last 5 autosave states" UI copy). */
export const CHECKPOINT_UNNAMED_CAP = 5

/**
 * Dedup and trim the stored checkpoint list — the one rule both platforms use.
 *
 * Identity is the EVENT id, not the d-tag. Every entry carries its own Blossom
 * URL and wrapped key, so it stays restorable even after a newer save replaces
 * the addressable relay event. The old rule deduped by d-tag, which deleted
 * every older autosave entry the moment a newer one existed (all autosaves
 * share `…:auto`) — one thin autosave from any device silently evicted the
 * only entry still pointing at the corkboard-rich blob, and "restore a
 * previous state" restored a state indistinguishable from the current one.
 *
 * Retention: named (user-created) checkpoints always survive. Unnamed ones
 * keep the newest `unnamedCap`, PLUS the richest by content whatever its age —
 * a run of thin autosaves must never age out the one checkpoint that still
 * has the corkboards.
 */
export function retainCheckpoints<T extends CheckpointEntry>(
  cps: readonly T[],
  unnamedCap: number = CHECKPOINT_UNNAMED_CAP,
): T[] {
  const byId = new Map<string, T>()
  for (const cp of cps) {
    const existing = byId.get(cp.eventId)
    if (!existing) { byId.set(cp.eventId, cp); continue }
    // Same event seen twice — a user-given name wins over an unnamed copy.
    if (!existing.name && cp.name) byId.set(cp.eventId, cp)
  }
  const sorted = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp)
  const named = sorted.filter(c => c.name)
  const unnamed = sorted.filter(c => !c.name)
  const kept = unnamed.slice(0, unnamedCap)
  if (unnamed.length > kept.length) {
    const richest = pickRichestManifest(
      unnamed.map(c => ({ id: c.eventId, timestamp: c.timestamp, stats: c.stats })),
    )
    if (!kept.some(c => c.eventId === richest.id)) {
      const rich = unnamed.find(c => c.eventId === richest.id)
      if (rich) kept.push(rich)
    }
  }
  return [...named, ...kept].sort((a, b) => b.timestamp - a.timestamp)
}

/** A checkpoint the user explicitly (not silently/automatically) restored. */
export interface ExplicitRestoreRecord {
  id: string
  timestamp: number
}

/**
 * Should a SILENT background sync skip auto-applying `candidateId`?
 *
 * A periodic check picks "newest" purely by wall-clock timestamp. A
 * clock-skewed device, or a save that raced a richer one, can make a WORSE
 * manifest permanently outrank whatever the user deliberately chose: every
 * future tick rediscovers it as "a different event, not yet synced" and
 * silently re-applies it, undoing the user's choice within moments —
 * regardless of which mode they restored in or how carefully they chose.
 *
 * Suppress only when the user has an explicit choice on record, the
 * candidate is a genuinely different event, AND local hasn't moved past that
 * choice since (if local's own last-backup-ts advanced past it — e.g. a
 * fresh manual save happened after — the guard would be defending a decision
 * that's already been superseded on this device, which is not its job).
 *
 * Deliberately does not silence the disagreement forever: a manual sync or
 * the checkpoint review UI still surfaces it so the user can act, rather than
 * the app quietly picking a side either way.
 */
export function shouldSuppressSilentSync(
  explicit: ExplicitRestoreRecord | null,
  candidateId: string,
  localBackupTs: number,
): boolean {
  if (!explicit) return false
  if (explicit.id === candidateId) return false
  return localBackupTs <= explicit.timestamp
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
