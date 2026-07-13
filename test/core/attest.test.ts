import { describe, it, expect } from 'vitest'
import { buildRecord, overlaps } from '../../src/core/attest'
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

describe('overlaps', () => {
  it('detects overlap and non-overlap', () => {
    expect(overlaps([1, 3], [3, 5])).toBe(true)
    expect(overlaps([1, 3], [4, 5])).toBe(false)
  })
})

describe('buildRecord', () => {
  it('hashes the range and sets headHash', () => {
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4], existingCurrent: [] })
    expect(r.hash).toBe(hashRangeOfText(DOC, [2, 4]).hash)
    expect(r.headHash).toBe(hashRangeOfText(DOC, [2, 4]).headHash)
    expect(r.supersedes).toBeUndefined()
  })

  it('auto-supersedes same-author overlapping current records only', () => {
    const mine = existing('old1', [3, 5])
    const other = existing('old2', [3, 5], OTHER)
    const far = existing('old3', [6, 6])
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4],
      existingCurrent: [mine, other, far] })
    expect(r.supersedes).toEqual(['old1'])
  })

  it('same symbol path counts as overlap even if ranges moved apart', () => {
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
