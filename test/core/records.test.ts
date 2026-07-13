import { describe, it, expect } from 'vitest'
import { parseJsonl, dedupeById, resolveChains, isTombstone } from '../../src/core/records'
import type { ReviewRecord, Tombstone } from '../../src/core/types'

const AUTHOR = { name: 'San', email: 's@x.com' }
function rec(id: string, createdAt: string, extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id, author: AUTHOR, createdAt, commit: 'c1', dirty: false, kind: 'selection',
    range: [1, 3], hash: 'sha256:aa', headHash: 'sha256:bb', ...extra }
}
function tomb(id: string, revokes: string): Tombstone {
  return { id, author: AUTHOR, createdAt: '2026-07-13T10:00:00Z', revokes, reason: 'unvouch' }
}

describe('parseJsonl', () => {
  it('parses records, skips corrupt lines and blanks, counts corruption', () => {
    const content = JSON.stringify(rec('a', '2026-01-01T00:00:00Z')) + '\n' +
      'NOT JSON\n' + '\n' + '{"noId": true}\n'
    const { lines, corrupt } = parseJsonl(content)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.id).toBe('a')
    expect(corrupt).toBe(2)
  })
})

describe('dedupeById', () => {
  it('keeps first occurrence (union-merge duplicates)', () => {
    const a1 = rec('a', '2026-01-01T00:00:00Z')
    const out = dedupeById([a1, rec('a', '2026-01-02T00:00:00Z'), rec('b', '2026-01-01T00:00:00Z')])
    expect(out.map(l => l.id)).toEqual(['a', 'b'])
  })
})

describe('resolveChains', () => {
  it('single record is its own chain and current', () => {
    const s = resolveChains([rec('a', '2026-01-01T00:00:00Z')])
    expect(s.current.map(r => r.id)).toEqual(['a'])
    expect(s.chains.size).toBe(1)
  })

  it('supersedes links records into one chain; latest wins', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
    ])
    expect(s.current.map(r => r.id)).toEqual(['b'])
    expect(s.chains.size).toBe(1)
    const chain = [...s.chains.values()][0]!
    expect(chain.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('fork (two records superseding same parent) resolves by createdAt, tie by id', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      rec('c', '2026-01-02T00:00:00Z', { supersedes: ['a'] }), // same timestamp fork
    ])
    expect(s.current.map(r => r.id)).toEqual(['c']) // 'c' > 'b'
  })

  it('revoking ANY record kills the whole chain — no resurrection', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      tomb('t1', 'b'), // revoke the re-review — 'a' must NOT come back
    ])
    expect(s.current).toHaveLength(0)
    expect(s.revokedChains.size).toBe(1)
  })

  it('revoking via an OLD id in the chain also kills the chain', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      tomb('t1', 'a'),
    ])
    expect(s.current).toHaveLength(0)
  })

  it('supersedes referencing a missing id still forms a chain', () => {
    const s = resolveChains([rec('b', '2026-01-02T00:00:00Z', { supersedes: ['ghost'] })])
    expect(s.current.map(r => r.id)).toEqual(['b'])
  })

  it('independent chains stay independent', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z', { range: [1, 3] }),
      rec('x', '2026-01-01T00:00:00Z', { range: [10, 12] }),
    ])
    expect(s.current).toHaveLength(2)
    expect(s.chains.size).toBe(2)
  })

  it('isTombstone discriminates', () => {
    expect(isTombstone(tomb('t', 'a'))).toBe(true)
    expect(isTombstone(rec('a', '2026-01-01T00:00:00Z'))).toBe(false)
  })
})
