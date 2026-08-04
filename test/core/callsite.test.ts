import { describe, it, expect } from 'vitest'
import { callTargetSpan, coveringEntries } from '../../src/core/callsite'
import type { SymbolNode, Resolution } from '../../src/core/anchor'
import type { ReviewRecord } from '../../src/core/types'

const SYMBOLS: SymbolNode[] = [
  {
    name: 'AuthService',
    kindClass: 'class',
    range: [10, 100],
    children: [
      { name: 'login', kindClass: 'function', range: [20, 40], children: [] },
      { name: 'logout', kindClass: 'function', range: [50, 60], children: [] },
    ],
  },
  { name: 'clearAppDataSafely', kindClass: 'function', range: [110, 130], children: [] },
]

describe('callTargetSpan', () => {
  it('keeps a full span untouched', () => {
    expect(callTargetSpan([110, 130], false, SYMBOLS)).toEqual([110, 130])
  })

  it('expands an identifier-only span to the enclosing symbol', () => {
    // Definition provider returned a plain Location: just the identifier line.
    expect(callTargetSpan([110, 110], true, SYMBOLS)).toEqual([110, 130])
  })

  it('expands to the deepest enclosing symbol, not the outermost', () => {
    expect(callTargetSpan([20, 20], true, SYMBOLS)).toEqual([20, 40])
  })

  it('keeps the identifier span when no symbol encloses it', () => {
    expect(callTargetSpan([200, 200], true, SYMBOLS)).toEqual([200, 200])
  })

  it('keeps the identifier span when symbols are unavailable', () => {
    expect(callTargetSpan([110, 110], true, null)).toEqual([110, 110])
  })
})

function entry(
  kind: ReviewRecord['kind'],
  effectiveRange: [number, number],
  status: Resolution['status'] = 'reviewed',
): { record: ReviewRecord; res: Resolution } {
  const record = {
    id: 'r1',
    author: { name: 'A', email: 'a@x.io' },
    createdAt: '2026-01-01T00:00:00Z',
    commit: 'c',
    dirty: false,
    kind,
    hash: 'h',
  } as ReviewRecord
  return { record, res: { status, effectiveRange } }
}

describe('coveringEntries', () => {
  it('always includes file-kind records', () => {
    const e = entry('file', [1, 500])
    expect(coveringEntries([e], [110, 130])).toEqual([e])
  })

  it('includes a selection review inside the span', () => {
    // Reviewed lines sit inside the function body, not on the signature line.
    const e = entry('selection', [115, 120])
    expect(coveringEntries([e], [110, 130])).toEqual([e])
  })

  it('includes a review overlapping the span edge', () => {
    const e = entry('selection', [125, 140])
    expect(coveringEntries([e], [110, 130])).toEqual([e])
  })

  it('excludes a review outside the span', () => {
    const e = entry('selection', [20, 40])
    expect(coveringEntries([e], [110, 130])).toEqual([])
  })
})
