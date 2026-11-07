import { describe, it, expect } from 'vitest'
import { fileCoverage, rollup, pct } from '../../src/core/coverage'
import type { ReviewRecord } from '../../src/core/types'
import type { Resolution } from '../../src/core/anchor'

const DOC = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj' // 10 lines
function entry(
  range: [number, number],
  status: 'reviewed' | 'dismissed' = 'reviewed',
  kind: 'selection' | 'file' = 'selection',
) {
  const record = { id: 'x', kind } as ReviewRecord
  const res: Resolution = { status, effectiveRange: range }
  return { record, res }
}

describe('fileCoverage', () => {
  it('union of reviewed ranges, overlaps counted once', () => {
    const c = fileCoverage([entry([1, 4]), entry([3, 6])], DOC)!
    expect(c).toEqual({ reviewedLines: 6, totalLines: 10 })
  })
  it('dismissed records contribute nothing', () => {
    const c = fileCoverage([entry([1, 4], 'dismissed')], DOC)!
    expect(c).toEqual({ reviewedLines: 0, totalLines: 10 })
  })
  it('live kind=file review → 100%', () => {
    const c = fileCoverage([entry([1, 10], 'reviewed', 'file')], DOC)!
    expect(c).toEqual({ reviewedLines: 10, totalLines: 10 })
  })
  it('empty file → null (excluded from rollups)', () => {
    expect(fileCoverage([], '')).toBeNull()
  })
  it('range clamped to totalLines (trailing-newline convention)', () => {
    const c = fileCoverage([entry([9, 11])], DOC + '\n')! // 10 lines by convention
    expect(c).toEqual({ reviewedLines: 2, totalLines: 10 })
  })
})

describe('fileCoverage — blank lines need no review', () => {
  // Two functions separated by a blank line, plus a trailing blank line.
  const TWO_FNS = 'fn a() {\n  1\n}\n\nfn b() {\n  2\n}\n   \n'
  it('blank and whitespace-only lines leave the denominator', () => {
    expect(fileCoverage([], TWO_FNS)).toEqual({ reviewedLines: 0, totalLines: 6 })
  })
  it('every function reviewed -> 100% even with blank lines between them', () => {
    const c = fileCoverage([entry([1, 3]), entry([5, 7])], TWO_FNS)!
    expect(c).toEqual({ reviewedLines: 6, totalLines: 6 })
    expect(pct(c)).toBe(100)
  })
  it('a reviewed range spanning blank lines counts only its code lines', () => {
    expect(fileCoverage([entry([3, 5])], TWO_FNS)).toEqual({ reviewedLines: 2, totalLines: 6 })
  })
  it('blank-only file -> null (excluded from rollups)', () => {
    expect(fileCoverage([], '\n  \n\t\n')).toBeNull()
  })
  it('kind=file review covers every code line', () => {
    const c = fileCoverage([entry([1, 8], 'reviewed', 'file')], TWO_FNS)!
    expect(c).toEqual({ reviewedLines: 6, totalLines: 6 })
  })
})

describe('rollup / pct', () => {
  it('raw line sums, nulls skipped', () => {
    const r = rollup([
      { reviewedLines: 5, totalLines: 10 },
      null,
      { reviewedLines: 0, totalLines: 30 },
    ])!
    expect(r).toEqual({ reviewedLines: 5, totalLines: 40 })
    expect(pct(r)).toBe(13)
  })
  it('all null → null (no NaN poisoning)', () => {
    expect(rollup([null, null])).toBeNull()
  })
})

describe('rollup with unreviewed entries (v1.1)', () => {
  it('sums {0,N} unreviewed files into the denominator', () => {
    expect(
      rollup([
        { reviewedLines: 3, totalLines: 3 },
        { reviewedLines: 0, totalLines: 7 },
      ]),
    ).toEqual({ reviewedLines: 3, totalLines: 10 })
  })
})

describe('pct — honest edges', () => {
  it('100 only when every line is reviewed', () => {
    expect(pct({ reviewedLines: 1999, totalLines: 2000 })).toBe(99)
    expect(pct({ reviewedLines: 2000, totalLines: 2000 })).toBe(100)
  })
  it('0 only when nothing is reviewed', () => {
    expect(pct({ reviewedLines: 1, totalLines: 2000 })).toBe(1)
    expect(pct({ reviewedLines: 0, totalLines: 2000 })).toBe(0)
  })
})
