import { describe, it, expect, beforeEach } from 'vitest'
import {
  shouldSweep,
  selectSweepBatch,
  MAX_PER_SWEEP,
  MIN_UNRESOLVED_TO_SWEEP,
  SWEEP_INTERVAL_MS,
} from './unresolvedSweep'
import {
  registerUnresolved,
  clearUnresolved,
  getUnresolvedIds,
  unresolvedCount,
  clearAllUnresolved,
} from './failedNotes'

const base = { unresolvedCount: 5, inFlight: false, hidden: false, now: 1_000_000, lastSweepAt: 0 }

describe('shouldSweep', () => {
  it('sweeps when there are enough unresolved references and nothing blocks it', () => {
    expect(shouldSweep(base)).toEqual({ sweep: true })
  })

  it('sweeps a single unresolved reference, and refuses only when there are none', () => {
    // The threshold used to be 2, on the theory that one stuck reference is
    // probably genuinely unreachable. In practice that one gray box is exactly
    // what the user is staring at, and once its per-id miss decay hit the
    // attempt ceiling nothing but the sweep could revive it — so "one
    // unresolved" meant "unresolved forever". The decay already bounds the
    // cost of retrying something truly dead.
    expect(shouldSweep({ ...base, unresolvedCount: 1 })).toEqual({ sweep: true })
    expect(shouldSweep({ ...base, unresolvedCount: MIN_UNRESOLVED_TO_SWEEP })).toEqual({ sweep: true })
    expect(shouldSweep({ ...base, unresolvedCount: 0 })).toEqual({
      sweep: false, reason: 'below-threshold',
    })
  })

  it('refuses while a sweep is already running', () => {
    expect(shouldSweep({ ...base, inFlight: true })).toEqual({ sweep: false, reason: 'in-flight' })
  })

  it('refuses when the app is backgrounded', () => {
    expect(shouldSweep({ ...base, hidden: true })).toEqual({ sweep: false, reason: 'hidden' })
  })

  it('refuses a second sweep inside the interval, and allows one after', () => {
    const lastSweepAt = base.now - 1_000
    expect(shouldSweep({ ...base, lastSweepAt })).toEqual({ sweep: false, reason: 'too-soon' })
    expect(shouldSweep({ ...base, lastSweepAt: base.now - SWEEP_INTERVAL_MS })).toEqual({ sweep: true })
  })

  it('checks in-flight before anything else — an overlapping call is never a sweep', () => {
    // A fetch-triggered call landing next to a tick: every other gate would pass.
    expect(shouldSweep({ ...base, inFlight: true, hidden: false, lastSweepAt: 0 }))
      .toEqual({ sweep: false, reason: 'in-flight' })
  })
})

describe('selectSweepBatch', () => {
  it('caps the batch so one sweep cannot starve the socket budget', () => {
    const ids = Array.from({ length: MAX_PER_SWEEP + 25 }, (_, i) => `id${i}`)
    const batch = selectSweepBatch(ids)
    expect(batch).toHaveLength(MAX_PER_SWEEP)
    expect(batch[0]).toBe('id0')
  })

  it('passes a short list through untouched', () => {
    expect(selectSweepBatch(['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('unresolved registry', () => {
  beforeEach(() => clearAllUnresolved())

  it('counts what is on screen and is not destroyed by reading', () => {
    registerUnresolved('a')
    registerUnresolved('b')
    expect(unresolvedCount()).toBe(2)
    // Reading twice must return the same thing — the old drain-on-read queue
    // returned [] the second time, which is why a sweep could only ever run once.
    expect(getUnresolvedIds()).toEqual(['a', 'b'])
    expect(getUnresolvedIds()).toEqual(['a', 'b'])
  })

  it('ignores duplicate registrations', () => {
    registerUnresolved('a')
    registerUnresolved('a')
    expect(unresolvedCount()).toBe(1)
  })

  it('drops a reference once it resolves or leaves the screen', () => {
    registerUnresolved('a')
    registerUnresolved('b')
    clearUnresolved('a')
    expect(getUnresolvedIds()).toEqual(['b'])
    clearUnresolved('nonexistent')
    expect(unresolvedCount()).toBe(1)
  })

  it('stays bounded if a caller ever leaks registrations', () => {
    for (let i = 0; i < 700; i++) registerUnresolved(`id${i}`)
    expect(unresolvedCount()).toBeLessThanOrEqual(500)
    // The newest registration survives; the oldest is what gets dropped.
    expect(getUnresolvedIds()).toContain('id699')
  })
})
