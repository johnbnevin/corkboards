import { describe, it, expect } from 'vitest'
import { createSyncScheduler } from './syncScheduler'

describe('createSyncScheduler', () => {
  it('goes idle only after the configured consecutive nothing-new checks', () => {
    const s = createSyncScheduler(3)
    s.recordCheckResult('nothing-new')
    s.recordCheckResult('nothing-new')
    expect(s.isIdle()).toBe(false)
    s.recordCheckResult('nothing-new')
    expect(s.isIdle()).toBe(true)
  })

  it('a found-new result clears the count', () => {
    const s = createSyncScheduler(3)
    s.recordCheckResult('nothing-new')
    s.recordCheckResult('nothing-new')
    s.recordCheckResult('found-new')
    expect(s.strikes()).toBe(0)
    expect(s.isIdle()).toBe(false)
  })

  it('failed checks are not strikes — an outage is not idleness', () => {
    const s = createSyncScheduler(3)
    s.recordCheckResult('nothing-new')
    s.recordCheckResult('failed')
    s.recordCheckResult('failed')
    expect(s.strikes()).toBe(1)
    expect(s.isIdle()).toBe(false)
  })

  it('failed checks do not clear existing strikes either', () => {
    const s = createSyncScheduler(2)
    s.recordCheckResult('nothing-new')
    s.recordCheckResult('nothing-new')
    expect(s.isIdle()).toBe(true)
    s.recordCheckResult('failed')
    expect(s.isIdle()).toBe(true)
  })

  it('every reset reason resumes checking immediately', () => {
    for (const reason of ['visible', 'focus', 'online', 'app-active', 'activity', 'local-save', 'login'] as const) {
      const s = createSyncScheduler(1)
      s.recordCheckResult('nothing-new')
      expect(s.isIdle()).toBe(true)
      s.reset(reason)
      expect(s.isIdle()).toBe(false)
      expect(s.strikes()).toBe(0)
    }
  })
})
