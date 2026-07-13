import { describe, it, expect } from 'vitest'
import { fileCoverage, rollup, pct } from '../../src/core/coverage'
import type { ReviewRecord } from '../../src/core/types'
import type { Resolution } from '../../src/core/anchor'

const DOC = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj' // 10 lines
function entry(range: [number, number], status: 'reviewed' | 'dismissed' = 'reviewed',
  kind: 'selection' | 'file' = 'selection') {
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

describe('rollup / pct', () => {
  it('raw line sums, nulls skipped', () => {
    const r = rollup([{ reviewedLines: 5, totalLines: 10 }, null, { reviewedLines: 0, totalLines: 30 }])!
    expect(r).toEqual({ reviewedLines: 5, totalLines: 40 })
    expect(pct(r)).toBe(13)
  })
  it('all null → null (no NaN poisoning)', () => {
    expect(rollup([null, null])).toBeNull()
  })
})
