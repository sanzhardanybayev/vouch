import { describe, it, expect } from 'vitest'
import { buildRecord, encloses, overlaps, supersedeCandidates } from '../../src/core/attest'
import { hashRangeOfText, resolveRecord } from '../../src/core/anchor'
import type { ReviewRecord } from '../../src/core/types'

const AUTHOR = { name: 'S', email: 's@x.com' }
const OTHER = { name: 'B', email: 'b@x.com' }
const DOC = 'l1\nl2\nl3\nl4\nl5\nl6'

const BASE = {
  id: 'new1', author: AUTHOR, createdAt: '2026-07-13T00:00:00Z',
  commit: 'c2', dirty: false, docText: DOC,
}

function existing(id: string, range: [number, number], author = AUTHOR) {
  const { hash, headHash } = hashRangeOfText(DOC, range)
  const record: ReviewRecord = { id, author, createdAt: '2026-01-01T00:00:00Z', commit: 'c1',
    dirty: false, kind: 'selection', range, hash, headHash }
  return { record, res: resolveRecord(record, DOC) }
}

// Hashes against a different doc so resolveRecord against DOC yields 'dismissed'
function existingDismissed(id: string, range: [number, number], author = AUTHOR) {
  const staleDoc = 'a1\na2\na3\na4\na5\na6'
  const { hash, headHash } = hashRangeOfText(staleDoc, range)
  const record: ReviewRecord = { id, author, createdAt: '2026-01-01T00:00:00Z', commit: 'c1',
    dirty: false, kind: 'selection', range, hash, headHash }
  return { record, res: resolveRecord(record, DOC) }
}

describe('overlaps', () => {
  it('detects overlap and non-overlap', () => {
    expect(overlaps([1, 3], [3, 5])).toBe(true)
    expect(overlaps([1, 3], [4, 5])).toBe(false)
  })
})

describe('encloses', () => {
  it('equal ranges count as enclosure', () => {
    expect(encloses([3, 5], [3, 5])).toBe(true)
  })

  it('strict enclosure', () => {
    expect(encloses([2, 5], [3, 4])).toBe(true)
  })

  it('inner does not enclose outer', () => {
    expect(encloses([3, 4], [2, 5])).toBe(false)
  })

  it('partial overlap is not enclosure', () => {
    expect(encloses([2, 4], [3, 5])).toBe(false)
    expect(encloses([3, 5], [2, 4])).toBe(false)
  })
})

describe('supersedeCandidates', () => {
  it('includes same-author fully enclosed records only', () => {
    const equal = existing('old1', [2, 4])
    const inside = existing('old2', [3, 3])
    const partial = existing('old3', [3, 5])
    const bigger = existing('old4', [1, 5])
    const far = existing('old5', [6, 6])
    const out = supersedeCandidates({ author: AUTHOR, kind: 'selection', range: [2, 4],
      existingCurrent: [equal, inside, partial, bigger, far] })
    expect(out.map(e => e.record.id)).toEqual(['old1', 'old2'])
  })

  it('never includes other-author records', () => {
    const other = existing('old1', [2, 4], OTHER)
    const out = supersedeCandidates({ author: AUTHOR, kind: 'selection', range: [1, 6],
      existingCurrent: [other] })
    expect(out).toEqual([])
  })

  it('kind=file includes all of the author records', () => {
    const a = existing('old1', [1, 2])
    const b = existing('old2', [5, 6])
    const other = existing('old3', [1, 2], OTHER)
    const out = supersedeCandidates({ author: AUTHOR, kind: 'file',
      existingCurrent: [a, b, other] })
    expect(out.map(e => e.record.id)).toEqual(['old1', 'old2'])
  })

  it('same symbol path counts even if ranges moved apart', () => {
    const mine = existing('old1', [1, 2])
    mine.record.symbol = 'AuthService/login'
    const out = supersedeCandidates({ author: AUTHOR, kind: 'function',
      symbol: 'AuthService/login', range: [5, 6], existingCurrent: [mine] })
    expect(out.map(e => e.record.id)).toEqual(['old1'])
  })

  it('includes dismissed current records like reviewed ones', () => {
    const dismissed = existingDismissed('old1', [2, 4])
    expect(dismissed.res.status).toBe('dismissed')
    const out = supersedeCandidates({ author: AUTHOR, kind: 'selection', range: [1, 5],
      existingCurrent: [dismissed] })
    expect(out.map(e => e.record.id)).toEqual(['old1'])
  })
})

describe('buildRecord', () => {
  it('hashes the range and sets headHash', () => {
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4], existingCurrent: [] })
    expect(r.hash).toBe(hashRangeOfText(DOC, [2, 4]).hash)
    expect(r.headHash).toBe(hashRangeOfText(DOC, [2, 4]).headHash)
    expect(r.supersedes).toBeUndefined()
  })

  it('does NOT supersede partially overlapping records', () => {
    const partial = existing('old1', [3, 5])
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4],
      existingCurrent: [partial] })
    expect(r.supersedes).toBeUndefined()
  })

  it('supersedes same-author enclosed current records only', () => {
    const mine = existing('old1', [3, 4])
    const equal = existing('old2', [2, 4])
    const other = existing('old3', [3, 4], OTHER)
    const bigger = existing('old4', [1, 6])
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4],
      existingCurrent: [mine, equal, other, bigger] })
    expect(r.supersedes).toEqual(['old1', 'old2'])
  })

  it('same symbol path counts as same unit even if ranges moved apart', () => {
    const mine = existing('old1', [1, 2])
    mine.record.symbol = 'AuthService/login'
    const r = buildRecord({ ...BASE, kind: 'function', symbol: 'AuthService/login',
      range: [5, 6], existingCurrent: [mine] })
    expect(r.supersedes).toEqual(['old1'])
  })

  it('kind=file supersedes ALL of the author records and hashes whole doc', () => {
    const a = existing('old1', [1, 2])
    const b = existing('old2', [5, 6])
    const other = existing('old3', [1, 2], OTHER)
    const r = buildRecord({ ...BASE, kind: 'file', existingCurrent: [a, b, other] })
    expect(r.supersedes).toEqual(['old1', 'old2'])
    expect(r.range).toBeUndefined()
    expect(r.headHash).toBeUndefined()
  })
})
