import { describe, it, expect } from 'vitest'
import {
  evaluateAutoSaveGuard,
  evaluateManifestThinness,
  evaluateMergeHold,
  verifyBlobMatchesManifest,
  pickRichestManifest,
  retainCheckpoints,
  shouldSuppressSilentSync,
  BLOB_MANIFEST_MAX_SKEW_SECS,
  type BackupCounts,
  type CheckpointEntry,
} from './backupGuards'

const counts = (over: Partial<BackupCounts> = {}): BackupCounts => ({
  dismissed: 100,
  feeds: 3,
  collapsed: 50,
  bookmarks: 10,
  ...over,
})

describe('evaluateAutoSaveGuard', () => {
  it('blocks when dismissed notes halve past the floor', () => {
    const v = evaluateAutoSaveGuard(counts({ dismissed: 100 }), counts({ dismissed: 40 }))
    expect(v.action).toBe('block')
    expect(v.action === 'block' && v.reason).toBe('dismissed-regressed')
  })

  it('does not block a small dismissed list halving (below the floor)', () => {
    const v = evaluateAutoSaveGuard(counts({ dismissed: 12 }), counts({ dismissed: 4 }))
    expect(v.action).toBe('proceed')
  })

  it('blocks when custom feeds drop to zero', () => {
    const v = evaluateAutoSaveGuard(counts({ feeds: 2 }), counts({ feeds: 0 }))
    expect(v.action).toBe('block')
    expect(v.action === 'block' && v.reason).toBe('feeds-zeroed')
  })

  it('never had feeds → zero feeds is fine', () => {
    const v = evaluateAutoSaveGuard(counts({ feeds: 0 }), counts({ feeds: 0 }))
    expect(v.action).toBe('proceed')
  })

  it('PROCEEDS with a warning when saved notes halve — cleanup is not damage', () => {
    // The old rule returned 'blocked' here, which silently paused auto-save
    // after the user cleaned out Save for Later. That was the bug.
    const v = evaluateAutoSaveGuard(
      counts({ collapsed: 60, bookmarks: 20 }),
      counts({ collapsed: 10, bookmarks: 5 }),
    )
    expect(v.action).toBe('proceed')
    expect(v.action === 'proceed' && v.warning).toBe('saved-cleanup')
  })

  it('no warning for a modest saved-notes reduction', () => {
    const v = evaluateAutoSaveGuard(counts({ collapsed: 50 }), counts({ collapsed: 40 }))
    expect(v.action).toBe('proceed')
    expect(v.action === 'proceed' && v.warning).toBeUndefined()
  })

  it('dismissed regression outranks the saved-cleanup warning', () => {
    const v = evaluateAutoSaveGuard(
      counts({ dismissed: 100, collapsed: 60 }),
      counts({ dismissed: 10, collapsed: 5 }),
    )
    expect(v.action).toBe('block')
  })
})

describe('evaluateManifestThinness', () => {
  it('accepts a manifest with far fewer saved notes (a cleanup must propagate)', () => {
    expect(
      evaluateManifestThinness({ savedForLater: 130, dismissed: 200 }, { savedForLater: 5, dismissed: 200 }),
    ).toBe('ok')
  })

  it('worries about a manifest with a big dismissed regression', () => {
    expect(
      evaluateManifestThinness({ savedForLater: 50, dismissed: 200 }, { savedForLater: 50, dismissed: 100 }),
    ).toBe('dismissed-regressed')
  })

  it('small dismissed lists never trigger the worry', () => {
    expect(
      evaluateManifestThinness({ dismissed: 50 }, { dismissed: 0 }),
    ).toBe('ok')
  })

  it('missing stats are treated as zero, not as a regression', () => {
    expect(evaluateManifestThinness(undefined, { dismissed: 5 })).toBe('ok')
    expect(evaluateManifestThinness({ dismissed: 40 }, undefined)).toBe('ok')
  })

  it('worries about ANY corkboard regression, however small', () => {
    // Corkboards are few and hand-curated — unlike dismissed/saved counts,
    // there is no "routine churn" floor for them.
    expect(
      evaluateManifestThinness({ corkboards: 5 }, { corkboards: 4 }),
    ).toBe('corkboards-regressed')
    expect(
      evaluateManifestThinness({ corkboards: 5 }, { corkboards: 1 }),
    ).toBe('corkboards-regressed')
  })

  it('missing corkboards on both sides is not a regression', () => {
    expect(evaluateManifestThinness({ corkboards: 0 }, { corkboards: 0 })).toBe('ok')
    expect(evaluateManifestThinness(undefined, { corkboards: 3 })).toBe('ok')
  })

  it('a saved-for-later cleanup does not trip the corkboards check', () => {
    expect(
      evaluateManifestThinness({ corkboards: 4, savedForLater: 130 }, { corkboards: 4, savedForLater: 5 }),
    ).toBe('ok')
  })
})

describe('evaluateMergeHold', () => {
  const LIMIT = 25

  it('never holds for saved-note removals, however many', () => {
    const v = evaluateMergeHold(
      [
        { key: 'collapsed-notes', ids: Array.from({ length: 80 }, (_, i) => `c${i}`) },
        { key: 'nostr-bookmark-ids', ids: Array.from({ length: 40 }, (_, i) => `b${i}`) },
      ],
      LIMIT,
    )
    expect(v.hold).toBe(false)
    expect(v.savedCleanupCount).toBe(120)
  })

  it('holds when dismissed removals exceed the silent limit', () => {
    const v = evaluateMergeHold(
      [{ key: 'dismissed-notes', ids: Array.from({ length: 26 }, (_, i) => `d${i}`) }],
      LIMIT,
    )
    expect(v.hold).toBe(true)
    expect(v.reason).toBe('dismissed-removals')
  })

  it('applies dismissed removals under the limit silently', () => {
    const v = evaluateMergeHold(
      [{ key: 'dismissed-notes', ids: ['a', 'b', 'c'] }],
      LIMIT,
    )
    expect(v.hold).toBe(false)
  })

  it('saved removals do not push guarded removals over the limit', () => {
    const v = evaluateMergeHold(
      [
        { key: 'collapsed-notes', ids: Array.from({ length: 100 }, (_, i) => `c${i}`) },
        { key: 'dismissed-notes', ids: ['a', 'b'] },
      ],
      LIMIT,
    )
    expect(v.hold).toBe(false)
    expect(v.guardedCount).toBe(2)
  })

  it('holds on mass removals of other guarded keys (pins)', () => {
    const v = evaluateMergeHold(
      [{ key: 'nostr-pinned-note-ids', ids: Array.from({ length: 30 }, (_, i) => `p${i}`) }],
      LIMIT,
    )
    expect(v.hold).toBe(true)
    expect(v.reason).toBe('other-removals')
  })

  it('holds on ANY corkboard removal, even just one — never lumped under the note-id limit', () => {
    const v = evaluateMergeHold(
      [{ key: 'nostr-custom-feeds', ids: ['board-1'] }],
      LIMIT,
    )
    expect(v.hold).toBe(true)
    expect(v.reason).toBe('corkboards-removed')
  })

  it('a single corkboard removal holds even alongside a huge, otherwise-silent saved cleanup', () => {
    const v = evaluateMergeHold(
      [
        { key: 'collapsed-notes', ids: Array.from({ length: 200 }, (_, i) => `c${i}`) },
        { key: 'nostr-custom-feeds', ids: ['board-1'] },
      ],
      LIMIT,
    )
    expect(v.hold).toBe(true)
    expect(v.reason).toBe('corkboards-removed')
  })
})

describe('pickRichestManifest', () => {
  it('prefers more corkboards over a later timestamp', () => {
    const winner = pickRichestManifest([
      { id: 'thin-but-newer', timestamp: 200, stats: { corkboards: 1, savedForLater: 5, dismissed: 5 } },
      { id: 'rich-but-older', timestamp: 100, stats: { corkboards: 4, savedForLater: 160, dismissed: 1863 } },
    ])
    expect(winner.id).toBe('rich-but-older')
  })

  it('falls back to combined saved+dismissed when corkboard counts tie', () => {
    const winner = pickRichestManifest([
      { id: 'less-data', timestamp: 200, stats: { corkboards: 2, savedForLater: 5, dismissed: 5 } },
      { id: 'more-data', timestamp: 100, stats: { corkboards: 2, savedForLater: 50, dismissed: 50 } },
    ])
    expect(winner.id).toBe('more-data')
  })

  it('falls back to timestamp when everything else ties — agrees with the plain newest pick', () => {
    const winner = pickRichestManifest([
      { id: 'older', timestamp: 100, stats: { corkboards: 2, savedForLater: 10, dismissed: 10 } },
      { id: 'newer', timestamp: 200, stats: { corkboards: 2, savedForLater: 10, dismissed: 10 } },
    ])
    expect(winner.id).toBe('newer')
  })

  it('treats missing stats as zero', () => {
    const winner = pickRichestManifest([
      { id: 'no-stats', timestamp: 999 },
      { id: 'has-stats', timestamp: 1, stats: { corkboards: 1 } },
    ])
    expect(winner.id).toBe('has-stats')
  })

  it('throws on an empty candidate list rather than silently returning undefined', () => {
    expect(() => pickRichestManifest([])).toThrow()
  })
})

describe('shouldSuppressSilentSync', () => {
  it('never suppresses when there is no explicit choice on record', () => {
    expect(shouldSuppressSilentSync(null, 'anything', 100)).toBe(false)
  })

  it('never suppresses when the candidate IS the explicit choice', () => {
    expect(shouldSuppressSilentSync({ id: 'x', timestamp: 100 }, 'x', 100)).toBe(false)
  })

  it('suppresses a different, clock-ahead candidate while local has not moved past the choice', () => {
    // The exact bug: the user restores checkpoint A (timestamp 100), the cloud's
    // clock-newest manifest is a DIFFERENT event B — every silent tick must not
    // re-apply B just because its timestamp looks bigger.
    expect(shouldSuppressSilentSync({ id: 'A', timestamp: 100 }, 'B', 100)).toBe(true)
  })

  it('stops suppressing once local has genuinely moved past the explicit choice', () => {
    // A fresh local save after the explicit restore means the guard's job here
    // is done — it must not keep defending a decision that's been superseded.
    expect(shouldSuppressSilentSync({ id: 'A', timestamp: 100 }, 'B', 150)).toBe(false)
  })

  it('does not suppress a candidate saved AFTER the user decided', () => {
    // The desktop keeps working after the phone's explicit restore. Its new
    // save postdates the decision — that is new work, not the stale
    // clock-winner the guard blocks, and muting it made the phone "never
    // pick up the desktop's saves" until a local edit happened.
    const explicit = { id: 'A', timestamp: 100, decidedAt: 200 }
    expect(shouldSuppressSilentSync(explicit, 'B', 100, 250)).toBe(false)
  })

  it('still suppresses a candidate that predates the decision', () => {
    const explicit = { id: 'A', timestamp: 100, decidedAt: 200 }
    expect(shouldSuppressSilentSync(explicit, 'B', 100, 150)).toBe(true)
  })

  it('falls back to the restore timestamp for legacy records without decidedAt', () => {
    // Old records lack decidedAt; a candidate newer than the restored
    // checkpoint itself is treated as new work.
    expect(shouldSuppressSilentSync({ id: 'A', timestamp: 100 }, 'B', 100, 150)).toBe(false)
    expect(shouldSuppressSilentSync({ id: 'A', timestamp: 100 }, 'B', 100, 90)).toBe(true)
  })

  it('keeps the legacy suppress behavior when no candidate timestamp is known', () => {
    expect(shouldSuppressSilentSync({ id: 'A', timestamp: 100, decidedAt: 200 }, 'B', 100)).toBe(true)
  })
})

describe('verifyBlobMatchesManifest', () => {
  const TS = 1_700_000_000

  it('accepts a v4 blob with no embedded timestamp', () => {
    expect(verifyBlobMatchesManifest(0, TS)).toBe(true)
  })

  it('accepts an exact match', () => {
    expect(verifyBlobMatchesManifest(TS, TS)).toBe(true)
  })

  it('accepts a blob written shortly before the manifest (slow signer)', () => {
    expect(verifyBlobMatchesManifest(TS - BLOB_MANIFEST_MAX_SKEW_SECS + 60, TS)).toBe(true)
  })

  it('rejects a blob older than the skew allowance', () => {
    expect(verifyBlobMatchesManifest(TS - BLOB_MANIFEST_MAX_SKEW_SECS - 1, TS)).toBe(false)
  })

  it('rejects a blob claiming to be NEWER than its manifest', () => {
    expect(verifyBlobMatchesManifest(TS + 30, TS)).toBe(false)
  })
})

describe('retainCheckpoints', () => {
  const cp = (
    eventId: string,
    timestamp: number,
    over: Partial<CheckpointEntry> = {},
  ): CheckpointEntry => ({ eventId, timestamp, ...over })

  it('keeps multiple checkpoints that share a d-tag (autosave history survives)', () => {
    // Regression: the old d-tag dedup collapsed every `…:auto` entry into one,
    // deleting the corkboard-rich state the moment a thin autosave happened.
    const rich = cp('rich', 100, { stats: { corkboards: 4, savedForLater: 10, dismissed: 50 } })
    const thin = cp('thin', 200, { stats: { corkboards: 0, savedForLater: 10, dismissed: 50 } })
    const out = retainCheckpoints([thin, rich])
    expect(out.map(c => c.eventId)).toEqual(['thin', 'rich'])
  })

  it('dedups identical event ids', () => {
    const out = retainCheckpoints([cp('a', 100), cp('a', 100), cp('b', 90)])
    expect(out.map(c => c.eventId)).toEqual(['a', 'b'])
  })

  it('a named duplicate wins over an unnamed copy of the same event', () => {
    const out = retainCheckpoints([cp('a', 100), cp('a', 100, { name: 'before-cleanup' })])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('before-cleanup')
  })

  it('caps unnamed checkpoints at the cap, newest first', () => {
    const many = Array.from({ length: 10 }, (_, i) => cp(`e${i}`, 100 + i))
    const out = retainCheckpoints(many, 5)
    expect(out).toHaveLength(5)
    expect(out[0].eventId).toBe('e9')
    expect(out[4].eventId).toBe('e5')
  })

  it('always retains the richest unnamed checkpoint even past the cap', () => {
    const rich = cp('rich', 1, { stats: { corkboards: 3, savedForLater: 0, dismissed: 0 } })
    const thin = Array.from({ length: 6 }, (_, i) => cp(`t${i}`, 100 + i))
    const out = retainCheckpoints([...thin, rich], 5)
    expect(out.some(c => c.eventId === 'rich')).toBe(true)
    expect(out).toHaveLength(6) // cap + the retained richest
  })

  it('named checkpoints always survive and do not consume the unnamed cap', () => {
    const named = cp('n', 1, { name: 'kept' })
    const unnamed = Array.from({ length: 6 }, (_, i) => cp(`u${i}`, 100 + i))
    const out = retainCheckpoints([named, ...unnamed], 5)
    expect(out.some(c => c.eventId === 'n')).toBe(true)
    expect(out.filter(c => !c.name)).toHaveLength(5)
  })

  it('sorts the result newest-first', () => {
    const out = retainCheckpoints([cp('old', 10), cp('new', 30), cp('mid', 20)])
    expect(out.map(c => c.eventId)).toEqual(['new', 'mid', 'old'])
  })
})
