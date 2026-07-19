import { describe, it, expect } from 'vitest'
import { shouldRequeue } from '../../src/core/requeue'

describe('shouldRequeue', () => {
  it('always requeues attested files, regardless of cache state', () => {
    expect(shouldRequeue(true, undefined)).toBe(true)
    expect(shouldRequeue(true, { reviewed: false })).toBe(true)
    expect(shouldRequeue(true, { reviewed: true })).toBe(true)
  })

  it('requeues an uncounted file (no cache entry) even when unattested', () => {
    expect(shouldRequeue(false, undefined)).toBe(true)
  })

  it(
    'requeues a file cached as reviewed even when no longer attested — ' +
      'the regression: a dismissed/revoked last review must not keep serving ' +
      'a stale reviewed:true entry forever',
    () => {
      expect(shouldRequeue(false, { reviewed: true })).toBe(true)
    },
  )

  it('leaves an already-counted, unreviewed, unattested file alone', () => {
    expect(shouldRequeue(false, { reviewed: false })).toBe(false)
  })
})
