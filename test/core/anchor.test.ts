import { describe, it, expect } from 'vitest'
import { resolveRecord, hashRangeOfText, HUGE_FILE_LINES } from '../../src/core/anchor'
import { splitLines } from '../../src/core/text'
import type { ReviewRecord } from '../../src/core/types'

const DOC = ['function a() {', '  return 1', '}', '', 'function b() {', '  return 2', '}'].join('\n')

function recFor(docText: string, range: [number, number], extra: Partial<ReviewRecord> = {}): ReviewRecord {
  const { hash, headHash } = hashRangeOfText(docText, range)
  return { id: 'r1', author: { name: 'S', email: 's@x.com' }, createdAt: '2026-01-01T00:00:00Z',
    commit: 'c', dirty: false, kind: 'selection', range, hash, headHash, ...extra }
}

describe('resolveRecord — text scan', () => {
  it('unchanged text at same place → reviewed', () => {
    const r = recFor(DOC, [1, 3])
    expect(resolveRecord(r, DOC)).toEqual({ status: 'reviewed', effectiveRange: [1, 3] })
  })

  it('code moved down (insert above) → reviewed at new range', () => {
    const r = recFor(DOC, [1, 3])
    const moved = '// new header\n' + DOC
    expect(resolveRecord(r, moved)).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })

  it('edited text → dismissed at clamped stored range', () => {
    const r = recFor(DOC, [1, 3])
    const edited = DOC.replace('return 1', 'return 42')
    expect(resolveRecord(r, edited)).toEqual({ status: 'dismissed', effectiveRange: [1, 3] })
  })

  it('deleted text in shrunken doc → dismissed, range clamped to doc length', () => {
    const r = recFor(DOC, [5, 7])
    const shrunk = 'x'
    expect(resolveRecord(r, shrunk)).toEqual({ status: 'dismissed', effectiveRange: [1, 1] })
  })

  it('duplicate matches → nearest to stored range wins', () => {
    const block = 'function dup() {\n  return 9\n}'
    const doc = [block, '', 'spacer', 'spacer', 'spacer', '', block].join('\n')
    const r = recFor(doc, [9, 11] as [number, number])
    const res = resolveRecord(r, doc)
    expect(res.status).toBe('reviewed')
    expect(res.effectiveRange).toEqual(r.range)
  })

  it('CRLF document matches LF-hashed record', () => {
    const r = recFor(DOC, [1, 3])
    const crlf = DOC.replace(/\n/g, '\r\n')
    expect(resolveRecord(r, crlf).status).toBe('reviewed')
  })
})

describe('resolveRecord — symbolRange step', () => {
  it('match at symbolRange → reviewed there (no scan)', () => {
    const r = recFor(DOC, [1, 3], { kind: 'function', symbol: 'a' })
    const moved = '// h\n' + DOC
    expect(resolveRecord(r, moved, [2, 4])).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })
  it('mismatch at symbolRange falls through to scan and can still find moved text', () => {
    const r = recFor(DOC, [1, 3], { kind: 'function', symbol: 'a' })
    const moved = '// h\n' + DOC
    // wrong symbolRange (points at function b) — scan must still find function a at [2,4]
    expect(resolveRecord(r, moved, [6, 8])).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })
})

describe('resolveRecord — kind=file', () => {
  it('whole-file match / mismatch', () => {
    const { hash } = hashRangeOfText(DOC, [1, splitLines(DOC).length])
    const r: ReviewRecord = { id: 'f', author: { name: 'S', email: 's@x.com' },
      createdAt: '2026-01-01T00:00:00Z', commit: 'c', dirty: false, kind: 'file', hash }
    expect(resolveRecord(r, DOC).status).toBe('reviewed')
    expect(resolveRecord(r, DOC + '\nx').status).toBe('dismissed')
  })
})

describe('resolveRecord — huge files', () => {
  it('over cap: exact stored-range window still detected, moved text is not', () => {
    const filler = Array.from({ length: HUGE_FILE_LINES + 5 }, (_, i) => `line ${i}`)
    const doc = filler.join('\n')
    const r = recFor(doc, [100, 102])
    expect(resolveRecord(r, doc).status).toBe('reviewed')          // window at stored range
    const moved = 'inserted\n' + doc                                // shifts everything by 1
    expect(resolveRecord(r, moved).status).toBe('dismissed')       // no scan over cap
  })
})
