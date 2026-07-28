import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordRemovalsFromWrite,
  getTombstones,
  clearTombstones,
  loadTombstones,
  serializeTombstones,
  mergeInTombstones,
  tombstoneCount,
  prune,
  isMergeClassifiedKey,
  TOMBSTONE_MAX_AGE_SECS,
  MAX_TOMBSTONES,
} from './tombstones'

const DISMISSED = 'dismissed-notes'
const BOARDS = 'nostr-custom-feeds'
const FILTERS = 'corkboard:tab-filters'
const NOW = 1_700_000_000

beforeEach(() => clearTombstones())

describe('recordRemovalsFromWrite', () => {
  it('tombstones ids that disappear from an id set', () => {
    const removed = recordRemovalsFromWrite(DISMISSED, '["a","b","c"]', '["a","c"]', NOW)
    expect(removed).toEqual(['b'])
    expect(getTombstones()[DISMISSED]).toEqual({ b: NOW })
  })

  it('records nothing for a pure addition', () => {
    expect(recordRemovalsFromWrite(DISMISSED, '["a"]', '["a","b"]', NOW)).toEqual([])
    expect(tombstoneCount()).toBe(0)
  })

  it('records a bulk clear as a tombstone per id', () => {
    // "Clear dismissed" has to stick across devices too.
    recordRemovalsFromWrite(DISMISSED, '["a","b","c"]', '[]', NOW)
    expect(getTombstones()[DISMISSED]).toEqual({ a: NOW, b: NOW, c: NOW })
  })

  it('treats a missing previous value as "unknown", not as a wipe', () => {
    // A first write, or one after a cache eviction, must not tombstone the world.
    expect(recordRemovalsFromWrite(DISMISSED, null, '["a"]', NOW)).toEqual([])
    expect(recordRemovalsFromWrite(DISMISSED, undefined, '[]', NOW)).toEqual([])
    expect(tombstoneCount()).toBe(0)
  })

  it('ignores keys that are not merge-classified', () => {
    expect(recordRemovalsFromWrite('corkboard:scroll-positions', '["a"]', '[]', NOW)).toEqual([])
    expect(isMergeClassifiedKey('corkboard:scroll-positions')).toBe(false)
    expect(isMergeClassifiedKey(DISMISSED)).toBe(true)
  })

  it('tombstones a deleted corkboard by its id', () => {
    const prev = JSON.stringify([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    const next = JSON.stringify([{ id: 'a', title: 'A' }])
    expect(recordRemovalsFromWrite(BOARDS, prev, next, NOW)).toEqual(['b'])
  })

  it('does not tombstone a corkboard that was merely edited', () => {
    const prev = JSON.stringify([{ id: 'a', title: 'A' }])
    const next = JSON.stringify([{ id: 'a', title: 'A renamed', pubkeys: ['p'] }])
    expect(recordRemovalsFromWrite(BOARDS, prev, next, NOW)).toEqual([])
  })

  it('tombstones a removed tab-filter entry', () => {
    expect(recordRemovalsFromWrite(FILTERS, '{"me":{},"work":{}}', '{"me":{}}', NOW)).toEqual(['work'])
  })

  it('survives corrupt values without recording anything', () => {
    expect(recordRemovalsFromWrite(DISMISSED, '{not json', '["a"]', NOW)).toEqual([])
    expect(recordRemovalsFromWrite(DISMISSED, '["a"]', 'also not json', NOW)).toEqual(['a'])
  })
})

describe('persistence and merging', () => {
  it('round-trips through serialize/load', () => {
    recordRemovalsFromWrite(DISMISSED, '["a","b"]', '["a"]', NOW)
    const raw = serializeTombstones()
    clearTombstones()
    expect(tombstoneCount()).toBe(0)
    loadTombstones(raw)
    expect(getTombstones()[DISMISSED]).toEqual({ b: NOW })
  })

  it('loads garbage as an empty log rather than throwing', () => {
    loadTombstones('not json')
    expect(getTombstones()).toEqual({})
    loadTombstones('[1,2,3]')
    expect(getTombstones()).toEqual({})
  })

  it('merges another device log, newest removal winning', () => {
    recordRemovalsFromWrite(DISMISSED, '["a","b"]', '["a"]', NOW)
    mergeInTombstones({ [DISMISSED]: { b: NOW + 500, c: NOW } })
    expect(getTombstones()[DISMISSED]).toEqual({ b: NOW + 500, c: NOW })
  })
})

describe('pruning', () => {
  it('forgets removals older than the retention window', () => {
    loadTombstones(JSON.stringify({
      [DISMISSED]: { ancient: NOW - TOMBSTONE_MAX_AGE_SECS - 1, recent: NOW - 10 },
    }))
    prune(NOW)
    expect(getTombstones()[DISMISSED]).toEqual({ recent: NOW - 10 })
  })

  it('drops the whole key once its last entry expires', () => {
    loadTombstones(JSON.stringify({ [DISMISSED]: { old: NOW - TOMBSTONE_MAX_AGE_SECS - 1 } }))
    prune(NOW)
    expect(getTombstones()[DISMISSED]).toBeUndefined()
  })

  it('caps the log, dropping the oldest first', () => {
    const ids: Record<string, number> = {}
    for (let i = 0; i < MAX_TOMBSTONES + 50; i++) ids[`id${i}`] = NOW - (MAX_TOMBSTONES + 50 - i)
    loadTombstones(JSON.stringify({ [DISMISSED]: ids }))
    prune(NOW)
    expect(tombstoneCount()).toBe(MAX_TOMBSTONES)
    expect(getTombstones()[DISMISSED]['id0']).toBeUndefined()
    expect(getTombstones()[DISMISSED][`id${MAX_TOMBSTONES + 49}`]).toBeDefined()
  })
})
