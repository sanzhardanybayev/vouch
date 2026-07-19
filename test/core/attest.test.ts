import { describe, it, expect } from 'vitest'
import { buildRecord, encloses, overlaps, rebaseRange, supersedeCandidates } from '../../src/core/attest'
import { ctxHashes } from '../../src/core/anchor'
import { splitLines } from '../../src/core/text'
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

describe('buildRecord — location capture', () => {
  it('selection records capture ctx hashes from the doc at the range', () => {
    const r = buildRecord({ ...BASE, kind: 'selection', range: [3, 4], existingCurrent: [] })
    const { before, after } = ctxHashes(splitLines(DOC), [3, 4])
    expect(r.ctxBefore).toBe(before)
    expect(r.ctxAfter).toBe(after)
  })

  it('ctx capture at top and bottom of file uses the empty-string hash', () => {
    const top = buildRecord({ ...BASE, kind: 'selection', range: [1, 1], existingCurrent: [] })
    const bottom = buildRecord({ ...BASE, kind: 'selection', range: [6, 6], existingCurrent: [] })
    expect(top.ctxBefore).toBe(ctxHashes(splitLines(DOC), [1, 1]).before)
    expect(bottom.ctxAfter).toBe(top.ctxBefore) // both hash ''
  })

  it('file-kind records carry no ctx hashes', () => {
    const r = buildRecord({ ...BASE, kind: 'file', existingCurrent: [] })
    expect(r.ctxBefore).toBeUndefined()
    expect(r.ctxAfter).toBeUndefined()
  })

  it('selection records store anchorSymbol (including the top-level sentinel), never symbol', () => {
    const anchored = buildRecord({ ...BASE, kind: 'selection', range: [2, 4],
      anchorSymbol: 'Svc/login', existingCurrent: [] })
    expect(anchored.anchorSymbol).toBe('Svc/login')
    expect(anchored.symbol).toBeUndefined()
    const top = buildRecord({ ...BASE, kind: 'selection', range: [2, 4],
      anchorSymbol: '', existingCurrent: [] })
    expect(top.anchorSymbol).toBe('')
  })

  it('function-kind records keep symbol and never anchorSymbol', () => {
    const r = buildRecord({ ...BASE, kind: 'function', symbol: 'Svc/login',
      range: [2, 4], existingCurrent: [] })
    expect(r.symbol).toBe('Svc/login')
    expect(r.anchorSymbol).toBeUndefined()
  })

  it('a selection inside your own reviewed function does NOT supersede the function record', () => {
    const fn = existing('fn1', [1, 6])
    fn.record.kind = 'function'
    fn.record.symbol = 'Svc/login'
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 3],
      anchorSymbol: 'Svc/login', existingCurrent: [fn] })
    expect(r.supersedes).toBeUndefined()
  })
})

describe('buildRecord — explicit supersede target', () => {
  it('unions a same-author current record id into the supersede set', () => {
    const far = existing('old5', [6, 6]) // not enclosed, heuristic would skip it
    const r = buildRecord({ ...BASE, kind: 'selection', range: [1, 2],
      supersedeId: 'old5', existingCurrent: [far] })
    expect(r.supersedes).toEqual(['old5'])
  })

  it('ignores a supersedeId owned by someone else', () => {
    const theirs = existing('old5', [6, 6], OTHER)
    const r = buildRecord({ ...BASE, kind: 'selection', range: [1, 2],
      supersedeId: 'old5', existingCurrent: [theirs] })
    expect(r.supersedes).toBeUndefined()
  })

  it('ignores a supersedeId that is no longer current', () => {
    const r = buildRecord({ ...BASE, kind: 'selection', range: [1, 2],
      supersedeId: 'vanished', existingCurrent: [] })
    expect(r.supersedes).toBeUndefined()
  })

  it('does not duplicate an id already in the heuristic set', () => {
    const mine = existing('old1', [1, 2])
    const r = buildRecord({ ...BASE, kind: 'selection', range: [1, 2],
      supersedeId: 'old1', existingCurrent: [mine] })
    expect(r.supersedes).toEqual(['old1'])
  })
})

describe('supersedeCandidates — identity normalization', () => {
  it('matches the author across email case/whitespace differences', () => {
    const mine = existing('old1', [2, 4])
    const out = supersedeCandidates({ author: { name: 'S', email: ' S@X.COM ' },
      kind: 'selection', range: [2, 4], existingCurrent: [mine] })
    expect(out.map(e => e.record.id)).toEqual(['old1'])
  })
})

describe('rebaseRange — content-anchored post-dialog guard', () => {
  const SNAP = 'a\nb\nc\nd\ne'

  it('unchanged text keeps its range', () => {
    expect(rebaseRange(SNAP, [2, 3], SNAP)).toEqual([2, 3])
  })

  it('insertion above rebases the range to the shifted location', () => {
    expect(rebaseRange(SNAP, [2, 3], 'import x\n' + SNAP)).toEqual([3, 4])
  })

  it('edited selection content aborts (null)', () => {
    expect(rebaseRange(SNAP, [2, 3], SNAP.replace('b', 'B'))).toBeNull()
  })

  it('duplicated selection content aborts (null)', () => {
    expect(rebaseRange(SNAP, [2, 3], SNAP + '\nb\nc')).toBeNull()
  })
})
