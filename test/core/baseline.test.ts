import { describe, it, expect } from 'vitest'
import { baselineSlice } from '../../src/core/baseline'
import { hashRangeOfText } from '../../src/core/anchor'
import { sha256, normalizeEol } from '../../src/core/text'
import type { ReviewRecord } from '../../src/core/types'

const COMMITTED = 'a\nb\nc\nd\ne\n'
function rec(range: [number, number], hash: string, kind: 'selection' | 'file' = 'selection'): ReviewRecord {
  return { id: 'r', author: { name: 'S', email: 's@x.com' }, createdAt: '2026-01-01T00:00:00Z',
    commit: 'c', dirty: false, kind, range: kind === 'file' ? undefined : range, hash }
}

describe('baselineSlice', () => {
  it('verified when committed slice matches the record hash', () => {
    const { hash } = hashRangeOfText(COMMITTED, [2, 4])
    const out = baselineSlice(COMMITTED, rec([2, 4], hash))
    expect(out).toEqual({ text: 'b\nc\nd', verified: true })
  })
  it('unverified when the reviewed text was never committed (dirty review)', () => {
    const out = baselineSlice(COMMITTED, rec([2, 4], 'sha256:doesnotmatch'))
    expect(out.verified).toBe(false)
    expect(out.text).toBe(COMMITTED) // falls back to whole committed file
  })
  it('kind=file verifies against the whole normalized file', () => {
    const hash = sha256(normalizeEol(COMMITTED))
    const out = baselineSlice(COMMITTED, rec([1, 1], hash, 'file'))
    expect(out.verified).toBe(true)
    expect(out.text).toBe(COMMITTED)
  })
  it('range beyond committed file length → unverified, whole file', () => {
    const out = baselineSlice('a\n', rec([5, 9], 'sha256:x'))
    expect(out.verified).toBe(false)
  })
})
