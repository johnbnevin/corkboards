import { describe, it, expect } from 'vitest'
import {
  evaluateAutoSaveGuard,
  evaluateManifestThinness,
  evaluateMergeHold,
  verifyBlobMatchesManifest,
  BLOB_MANIFEST_MAX_SKEW_SECS,
  type BackupCounts,
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

  it('holds on mass removals of other guarded keys (pins, boards)', () => {
    const v = evaluateMergeHold(
      [{ key: 'nostr-pinned-note-ids', ids: Array.from({ length: 30 }, (_, i) => `p${i}`) }],
      LIMIT,
    )
    expect(v.hold).toBe(true)
    expect(v.reason).toBe('other-removals')
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
