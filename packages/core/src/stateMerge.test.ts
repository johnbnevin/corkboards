import { describe, it, expect } from 'vitest'
import {
  mergeState,
  mergeTombstones,
  mergeRemovesLocalData,
  mergeBookmarkSnapshot,
  type StateSnapshot,
} from './stateMerge'

const DISMISSED = 'dismissed-notes'
const BOARDS = 'nostr-custom-feeds'
const FILTERS = 'corkboard:tab-filters'

function snap(keys: Record<string, string | null>, savedAt: number, tombstones = {}): StateSnapshot {
  return { keys, savedAt, tombstones }
}

describe('mergeState — id sets', () => {
  it('unions both devices, losing nothing from either', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a', 'b']) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['b', 'c']) }, 200)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[DISMISSED]!)).toEqual(['a', 'b', 'c'])
  })

  it('restores everything after a local wipe — union with empty is the cloud', () => {
    // The case the user cares about: a wiped device must come back fully, and
    // it must not need any heuristic about which side "looks fuller".
    const local = snap({ [DISMISSED]: JSON.stringify([]) }, 300)
    const remote = snap({ [DISMISSED]: JSON.stringify(['a', 'b', 'c']) }, 100)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[DISMISSED]!)).toEqual(['a', 'b', 'c'])
  })

  it('keeps offline local work even when the cloud snapshot is newer', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['offline1', 'offline2']) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['cloud1']) }, 999)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[DISMISSED]!).sort()).toEqual(['cloud1', 'offline1', 'offline2'])
  })

  it('leaves the value untouched when both sides already agree', () => {
    const same = JSON.stringify(['a', 'b'])
    const out = mergeState(snap({ [DISMISSED]: same }, 100), snap({ [DISMISSED]: same }, 200))
    expect(out.changedKeys).not.toContain(DISMISSED)
  })
})

describe('mergeState — tombstones', () => {
  it('keeps a removal from coming back from the other device', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a']) }, 300, { [DISMISSED]: { b: 250 } })
    const remote = snap({ [DISMISSED]: JSON.stringify(['a', 'b']) }, 200)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[DISMISSED]!)).toEqual(['a'])
    expect(out.removals).toEqual([{ key: DISMISSED, ids: ['b'] }])
  })

  it('lets a re-add after the removal win', () => {
    // Removed at 250, but the remote snapshot at 400 still has it — so it was
    // put back after the deletion, and the newer fact is the re-add.
    const local = snap({ [DISMISSED]: JSON.stringify(['a']) }, 300, { [DISMISSED]: { b: 250 } })
    const remote = snap({ [DISMISSED]: JSON.stringify(['a', 'b']) }, 400)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[DISMISSED]!).sort()).toEqual(['a', 'b'])
    expect(out.removals).toEqual([])
  })

  it("honours the other device's tombstone against local data", () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a', 'gone']) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['a']) }, 500, { [DISMISSED]: { gone: 400 } })
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[DISMISSED]!)).toEqual(['a'])
    expect(mergeRemovesLocalData(out)).toBe(true)
  })

  it('merges tombstone maps newest-wins', () => {
    const merged = mergeTombstones({ k: { a: 10, b: 5 } }, { k: { a: 20, c: 1 } })
    expect(merged).toEqual({ k: { a: 20, b: 5, c: 1 } })
  })
})

describe('mergeState — corkboards', () => {
  const boardA = { id: 'a', title: 'A', pubkeys: ['p1'] }
  const boardAEdited = { id: 'a', title: 'A renamed', pubkeys: ['p1', 'p2'] }
  const boardB = { id: 'b', title: 'B', pubkeys: [] }

  it('keeps a board created on the other device', () => {
    const local = snap({ [BOARDS]: JSON.stringify([boardA]) }, 100)
    const remote = snap({ [BOARDS]: JSON.stringify([boardB]) }, 200)
    const out = mergeState(local, remote)
    const ids = JSON.parse(out.keys[BOARDS]!).map((b: { id: string }) => b.id)
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('takes the newer snapshot version of a board edited on both', () => {
    const local = snap({ [BOARDS]: JSON.stringify([boardA]) }, 100)
    const remote = snap({ [BOARDS]: JSON.stringify([boardAEdited]) }, 200)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[BOARDS]!)[0].title).toBe('A renamed')
  })

  it('does not resurrect a deleted board', () => {
    const local = snap({ [BOARDS]: JSON.stringify([boardA]) }, 300, { [BOARDS]: { b: 250 } })
    const remote = snap({ [BOARDS]: JSON.stringify([boardA, boardB]) }, 200)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[BOARDS]!).map((b: { id: string }) => b.id)).toEqual(['a'])
  })
})

describe('mergeState — maps and scalars', () => {
  it('merges tab filters per tab, newer snapshot winning a shared tab', () => {
    const local = snap({ [FILTERS]: JSON.stringify({ me: { columnCount: 2 }, home: { columnCount: 1 } }) }, 100)
    const remote = snap({ [FILTERS]: JSON.stringify({ me: { columnCount: 5 }, work: { columnCount: 3 } }) }, 200)
    const merged = JSON.parse(mergeState(local, remote).keys[FILTERS]!)
    expect(merged.me.columnCount).toBe(5)   // remote is newer
    expect(merged.home.columnCount).toBe(1) // local-only survives
    expect(merged.work.columnCount).toBe(3) // remote-only survives
  })

  it('last-write-wins a scalar when the remote is newer', () => {
    const out = mergeState(snap({ 'corkboard:active-tab': '"me"' }, 100), snap({ 'corkboard:active-tab': '"discover"' }, 200))
    expect(out.keys['corkboard:active-tab']).toBe('"discover"')
  })

  it('keeps the local scalar when local is newer', () => {
    const out = mergeState(snap({ 'corkboard:active-tab': '"me"' }, 500), snap({ 'corkboard:active-tab': '"discover"' }, 200))
    expect(out.changedKeys).not.toContain('corkboard:active-tab')
  })

  it('treats a key missing from the remote as "never written", not as a deletion', () => {
    // A device that has never saved this key must not wipe it everywhere else.
    const out = mergeState(snap({ 'corkboard:sticky-tab-bar': 'true' }, 100), snap({}, 900))
    expect(out.changedKeys).not.toContain('corkboard:sticky-tab-bar')
  })
})

describe('mergeState — safety', () => {
  it('reports no removals for a pure addition, so it can apply silently', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a']) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['a', 'b']) }, 200)
    expect(mergeRemovesLocalData(mergeState(local, remote))).toBe(false)
  })

  it('survives corrupt JSON on either side without throwing or losing the good side', () => {
    const local = snap({ [DISMISSED]: '{not json' }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['a']) }, 200)
    expect(JSON.parse(mergeState(local, remote).keys[DISMISSED]!)).toEqual(['a'])
  })

  it('ignores non-string ids in a set', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a', 42, null]) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['b']) }, 200)
    expect(JSON.parse(mergeState(local, remote).keys[DISMISSED]!)).toEqual(['a', 'b'])
  })

  it('is idempotent — merging the same remote twice changes nothing the second time', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a']) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['b']) }, 200)
    const first = mergeState(local, remote)
    const second = mergeState(
      { keys: { ...local.keys, ...first.keys }, savedAt: 200, tombstones: first.tombstones },
      remote,
    )
    expect(second.changedKeys).toEqual([])
  })
})

describe('mergeState — monotonic numeric keys (notifications last-seen)', () => {
  const SEEN = 'corkboard:notifications-last-seen'

  it('keeps the NEWER marker when the remote snapshot is newer but its marker is older', () => {
    // The regression this exists for: a device that has not opened
    // notifications in weeks saves more recently, and last-write-wins hands
    // its stale marker to a device that had read further — resurrecting a
    // badge for notifications the user already read.
    const local = snap({ [SEEN]: JSON.stringify(5000) }, 100)
    const remote = snap({ [SEEN]: JSON.stringify(1000) }, 200)
    expect(JSON.parse(mergeState(local, remote).keys[SEEN]!)).toBe(5000)
  })

  it('adopts the remote marker when it is genuinely further ahead', () => {
    const local = snap({ [SEEN]: JSON.stringify(1000) }, 200)
    const remote = snap({ [SEEN]: JSON.stringify(5000) }, 100)
    expect(JSON.parse(mergeState(local, remote).keys[SEEN]!)).toBe(5000)
  })

  it('takes the remote marker when this device has none', () => {
    const local = snap({}, 100)
    const remote = snap({ [SEEN]: JSON.stringify(4200) }, 50)
    expect(JSON.parse(mergeState(local, remote).keys[SEEN]!)).toBe(4200)
  })

  it('leaves the key absent when neither side has one', () => {
    const local = snap({ [DISMISSED]: JSON.stringify(['a']) }, 100)
    const remote = snap({ [DISMISSED]: JSON.stringify(['b']) }, 200)
    expect(mergeState(local, remote).keys[SEEN] ?? null).toBeNull()
  })

  it('does not report a change when the local marker already wins', () => {
    const local = snap({ [SEEN]: JSON.stringify(5000) }, 100)
    const remote = snap({ [SEEN]: JSON.stringify(1000) }, 200)
    expect(mergeState(local, remote).changedKeys).not.toContain(SEEN)
  })
})

describe('mergeState — undo after dismiss (the grave must be erased)', () => {
  const SAVED = 'collapsed-notes'

  it('an incoming merge deletes an undone re-add while its grave stands', () => {
    // Dismiss at T=150 tombstones the id. Undo re-adds it locally, but the
    // local snapshot's savedAt is still the LAST backup time (100 < 150), so
    // with the grave in place the merge reads the removal as the newer fact.
    const local = snap({ [SAVED]: JSON.stringify(['x']) }, 100, { [SAVED]: { x: 150 } })
    const remote = snap({ [SAVED]: JSON.stringify([]) }, 140)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[SAVED]!)).toEqual([])
    expect(mergeRemovesLocalData(out)).toBe(true)
  })

  it('with the grave cleared, the undone id survives the same merge', () => {
    // This is why undo calls clearTombstonesFor: same snapshots, no grave.
    const local = snap({ [SAVED]: JSON.stringify(['x']) }, 100, {})
    const remote = snap({ [SAVED]: JSON.stringify([]) }, 140)
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[SAVED]!)).toEqual(['x'])
    expect(mergeRemovesLocalData(out)).toBe(false)
  })

  it('a remote-carried grave cannot delete an id re-added after it', () => {
    // Another device may still carry the old grave in its snapshot. The undo
    // is safe as long as the re-adding side's snapshot is newer than the grave.
    const local = snap({ [SAVED]: JSON.stringify(['x']) }, 200, {})
    const remote = snap({ [SAVED]: JSON.stringify([]) }, 140, { [SAVED]: { x: 150 } })
    const out = mergeState(local, remote)
    expect(JSON.parse(out.keys[SAVED]!)).toEqual(['x'])
  })
})

describe('mergeBookmarkSnapshot — relay kind-10003 vs local state', () => {
  it('merges genuinely-new relay ids in', () => {
    const out = mergeBookmarkSnapshot(['a'], ['a', 'b'], 500, {})
    expect(out.ids).toEqual(['a', 'b'])
    expect(out.changed).toBe(true)
  })

  it('a local removal beats an OLDER relay copy — no resurrection', () => {
    // The live bug: dismiss a saved note, and five minutes later the stale
    // relay list re-unioned the id straight back into the count.
    const out = mergeBookmarkSnapshot(['a'], ['a', 'removed'], 500, { removed: 600 })
    expect(out.ids).toEqual(['a'])
    expect(out.changed).toBe(false)
  })

  it('a relay event NEWER than the grave re-adds the id (re-bookmarked elsewhere)', () => {
    const out = mergeBookmarkSnapshot(['a'], ['a', 'x'], 700, { x: 600 })
    expect(out.ids).toEqual(['a', 'x'])
  })

  it('every local id survives, grave or not — local state is the live truth', () => {
    const out = mergeBookmarkSnapshot(['undone'], [], 500, { undone: 999 })
    expect(out.ids).toEqual(['undone'])
  })

  it('returns the same array identity when nothing changed', () => {
    const local = ['a', 'b']
    const out = mergeBookmarkSnapshot(local, ['b', 'a'], 500, {})
    expect(out.ids).toBe(local)
    expect(out.changed).toBe(false)
  })
})
