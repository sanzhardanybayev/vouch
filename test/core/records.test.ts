import { describe, it, expect } from 'vitest'
import { parseJsonl, dedupeById, resolveChains, isTombstone } from '../../src/core/records'
import type { ReviewRecord, Tombstone } from '../../src/core/types'

const AUTHOR = { name: 'San', email: 's@x.com' }
const OTHER = { name: 'Bob', email: 'b@x.com' }
function rec(id: string, createdAt: string, extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id, author: AUTHOR, createdAt, commit: 'c1', dirty: false, kind: 'selection',
    range: [1, 3], hash: 'sha256:aa', headHash: 'sha256:bb', ...extra }
}
function tomb(id: string, revokes: string, extra: Partial<Tombstone> = {}): Tombstone {
  return { id, author: AUTHOR, createdAt: '2026-07-13T10:00:00Z', revokes, reason: 'unvouch', ...extra }
}
const jl = (...objs: object[]): string => objs.map(o => JSON.stringify(o)).join('\n') + '\n'

describe('parseJsonl', () => {
  it('parses records, skips corrupt lines and blanks, counts corruption', () => {
    const content = JSON.stringify(rec('a', '2026-01-01T00:00:00Z')) + '\n' +
      'NOT JSON\n' + '\n' + '{"noId": true}\n'
    const { lines, corrupt } = parseJsonl(content)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.id).toBe('a')
    expect(corrupt).toBe(2)
  })

  it('accepts every legacy 0.0.2 line shape', () => {
    const fileRec = { id: 'f', author: AUTHOR, createdAt: '2026-01-01T00:00:00Z',
      commit: '', dirty: false, kind: 'file', hash: 'sha256:aa' }
    const moved = tomb('t', 'a', { reason: 'moved', movedTo: 'src/new.ts' })
    const { lines, corrupt } = parseJsonl(jl(rec('a', '2026-01-01T00:00:00Z'), fileRec, moved))
    expect(lines).toHaveLength(3)
    expect(corrupt).toBe(0)
  })

  it('accepts new-format fields (anchorSymbol, ctxBefore, ctxAfter)', () => {
    const r = rec('a', '2026-01-01T00:00:00Z',
      { anchorSymbol: 'AuthService/login', ctxBefore: 'sha256:cc', ctxAfter: 'sha256:dd' })
    const { lines, corrupt } = parseJsonl(jl(r))
    expect(lines).toHaveLength(1)
    expect(corrupt).toBe(0)
  })

  it('rejects records with missing or malformed author', () => {
    const noAuthor = { ...rec('a', '2026-01-01T00:00:00Z') } as Record<string, unknown>
    delete noAuthor.author
    const badAuthor = { ...rec('b', '2026-01-01T00:00:00Z'), author: 'san' }
    const noEmail = { ...rec('c', '2026-01-01T00:00:00Z'), author: { name: 'S' } }
    const { lines, corrupt } = parseJsonl(jl(noAuthor, badAuthor, noEmail))
    expect(lines).toHaveLength(0)
    expect(corrupt).toBe(3)
  })

  it('rejects records with missing hash or createdAt', () => {
    const noHash = { ...rec('a', '2026-01-01T00:00:00Z') } as Record<string, unknown>
    delete noHash.hash
    const noDate = { ...rec('b', '2026-01-01T00:00:00Z') } as Record<string, unknown>
    delete noDate.createdAt
    const { lines, corrupt } = parseJsonl(jl(noHash, noDate))
    expect(lines).toHaveLength(0)
    expect(corrupt).toBe(2)
  })

  it('rejects malformed ranges (reversed, fractional, below 1, wrong arity, non-numeric)', () => {
    const shapes = [[3, 1], [1.5, 2], [0, 3], [1], ['a', 'b'], [1, 2, 3]]
    const content = jl(...shapes.map((range, i) =>
      ({ ...rec(`r${i}`, '2026-01-01T00:00:00Z'), range })))
    const { lines, corrupt } = parseJsonl(content)
    expect(lines).toHaveLength(0)
    expect(corrupt).toBe(shapes.length)
  })

  it('rejects a record whose supersedes contains its own id', () => {
    const { lines, corrupt } = parseJsonl(jl(rec('a', '2026-01-01T00:00:00Z', { supersedes: ['a'] })))
    expect(lines).toHaveLength(0)
    expect(corrupt).toBe(1)
  })

  it('rejects malformed supersedes and ctx fields', () => {
    const badSup = { ...rec('a', '2026-01-01T00:00:00Z'), supersedes: 'x' }
    const badSupEntry = { ...rec('b', '2026-01-01T00:00:00Z'), supersedes: [1] }
    const badCtx = { ...rec('c', '2026-01-01T00:00:00Z'), ctxBefore: 7 }
    const { lines, corrupt } = parseJsonl(jl(badSup, badSupEntry, badCtx))
    expect(lines).toHaveLength(0)
    expect(corrupt).toBe(3)
  })

  it('rejects tombstones missing revokes-target or reason', () => {
    const noReason = { id: 't1', author: AUTHOR, createdAt: '2026-01-01T00:00:00Z', revokes: 'a' }
    const emptyReason = { ...tomb('t2', 'a'), reason: '' }
    const { lines, corrupt } = parseJsonl(jl(noReason, emptyReason))
    expect(lines).toHaveLength(0)
    expect(corrupt).toBe(2)
  })

  it('forward compat: unknown extra fields, unknown kind, unknown tombstone reason all parse clean', () => {
    const extra = { ...rec('a', '2026-01-01T00:00:00Z'), futureField: { x: 1 } }
    const futureKind = { ...rec('b', '2026-01-01T00:00:00Z'), kind: 'paragraph' }
    const futureReason = { ...tomb('t', 'a'), reason: 'resolved' }
    const { lines, corrupt } = parseJsonl(jl(extra, futureKind, futureReason))
    expect(lines).toHaveLength(3)
    expect(corrupt).toBe(0)
  })
})

describe('dedupeById', () => {
  it('collapses byte-identical duplicate records (union-merge case)', () => {
    const a = rec('a', '2026-01-01T00:00:00Z')
    const { lines, corrupt } = dedupeById([a, structuredClone(a), rec('b', '2026-01-01T00:00:00Z')])
    expect(lines.map(l => l.id).sort()).toEqual(['a', 'b'])
    expect(corrupt).toBe(0)
  })

  it('drops ALL records sharing an id with differing content, counts them corrupt', () => {
    const v1 = rec('a', '2026-01-01T00:00:00Z')
    const v2 = rec('a', '2026-01-02T00:00:00Z')
    for (const order of [[v1, v2], [v2, v1]]) {
      const { lines, corrupt } = dedupeById(order)
      expect(lines).toHaveLength(0)
      expect(corrupt).toBe(2)
    }
  })

  it('a record colliding with a tombstone id is dropped in every input order', () => {
    const fake = rec('dup', '2026-01-01T00:00:00Z')
    const t = tomb('dup', 'x')
    for (const order of [[fake, t], [t, fake]]) {
      const { lines } = dedupeById(order)
      expect(lines).toHaveLength(1)
      expect(isTombstone(lines[0]!)).toBe(true)
    }
  })

  it('never drops tombstones, even on tombstone-vs-tombstone id collision', () => {
    const real = tomb('t1', 'victim-record')
    const decoy = tomb('t1', 'nonexistent')
    for (const order of [[real, decoy], [decoy, real]]) {
      const { lines } = dedupeById(order)
      const revokeTargets = lines.filter(isTombstone).map(t => t.revokes).sort()
      expect(revokeTargets).toEqual(['nonexistent', 'victim-record'])
    }
  })
})

describe('resolveChains — author binding', () => {
  it('ignores a cross-author supersedes edge: victim record stays current', () => {
    const victim = rec('v', '2026-01-01T00:00:00Z')
    const attacker = rec('atk', '9999-01-01T00:00:00Z', { author: OTHER, supersedes: ['v'] })
    const s = resolveChains([victim, attacker])
    expect(s.current.map(r => r.id).sort()).toEqual(['atk', 'v'])
    expect(s.chains.size).toBe(2)
  })

  it('ignores a cross-author unvouch tombstone', () => {
    const victim = rec('v', '2026-01-01T00:00:00Z')
    const s = resolveChains([victim, tomb('t', 'v', { author: OTHER })])
    expect(s.current.map(r => r.id)).toEqual(['v'])
    expect(s.revokedChains.size).toBe(0)
  })

  it('honors a same-author tombstone with case/whitespace-differing email', () => {
    const r = rec('a', '2026-01-01T00:00:00Z')
    const t = tomb('t', 'a', { author: { name: 'San', email: ' S@X.com ' } })
    const s = resolveChains([r, t])
    expect(s.current).toHaveLength(0)
  })

  it('honors same-author supersede with case-differing email', () => {
    const a = rec('a', '2026-01-01T00:00:00Z')
    const b = rec('b', '2026-01-02T00:00:00Z',
      { author: { name: 'San', email: 'S@X.COM' }, supersedes: ['a'] })
    const s = resolveChains([a, b])
    expect(s.current.map(r => r.id)).toEqual(['b'])
  })

  it('ignores a cross-author moved tombstone with no verified copy', () => {
    const victim = rec('v', '2026-01-01T00:00:00Z')
    const t = tomb('t', 'v', { author: OTHER, reason: 'moved', movedTo: 'src/new.ts' })
    const s = resolveChains([victim, t], new Map())
    expect(s.current.map(r => r.id)).toEqual(['v'])
  })

  it('honors a legacy cross-author moved tombstone when a matching copy exists elsewhere', () => {
    const victim = rec('v', '2026-01-01T00:00:00Z')
    const t = tomb('t', 'v', { author: OTHER, reason: 'moved', movedTo: 'src/new.ts' })
    const movedIndex = new Map([['v', [{ email: 's@x.com', hash: 'sha256:aa' }]]])
    const s = resolveChains([victim, t], movedIndex)
    expect(s.current).toHaveLength(0)
  })

  it('rejects a moved tombstone whose copy has a mismatching hash or author', () => {
    const victim = rec('v', '2026-01-01T00:00:00Z')
    const t = tomb('t', 'v', { author: OTHER, reason: 'moved', movedTo: 'src/new.ts' })
    const wrongHash = new Map([['v', [{ email: 's@x.com', hash: 'sha256:zz' }]]])
    const wrongAuthor = new Map([['v', [{ email: 'b@x.com', hash: 'sha256:aa' }]]])
    expect(resolveChains([victim, t], wrongHash).current).toHaveLength(1)
    expect(resolveChains([victim, t], wrongAuthor).current).toHaveLength(1)
  })

  it('ignores a tombstone whose target id has no record (cannot verify ownership)', () => {
    const mine = rec('b', '2026-01-02T00:00:00Z', { supersedes: ['ghost'] })
    const s = resolveChains([mine, tomb('t', 'ghost', { author: OTHER })])
    expect(s.current.map(r => r.id)).toEqual(['b'])
  })
})

describe('resolveChains — topology', () => {
  it('single record is its own chain and current', () => {
    const s = resolveChains([rec('a', '2026-01-01T00:00:00Z')])
    expect(s.current.map(r => r.id)).toEqual(['a'])
    expect(s.chains.size).toBe(1)
  })

  it('supersedes links records into one chain; the superseder wins', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
    ])
    expect(s.current.map(r => r.id)).toEqual(['b'])
    expect(s.chains.size).toBe(1)
    const chain = [...s.chains.values()][0]!
    expect(chain.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('a superseded record never wins on a later timestamp (clock skew)', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T10:00:00Z'),                        // clock 10 min fast
      rec('b', '2026-01-01T09:50:00Z', { supersedes: ['a'] }), // explicit replacement
    ])
    expect(s.current.map(r => r.id)).toEqual(['b'])
  })

  it('fork (two records superseding same parent) resolves by createdAt, tie by id', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      rec('c', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
    ])
    expect(s.current.map(r => r.id)).toEqual(['c'])
  })

  it('hand-made 2-cycle still yields exactly one current record', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z', { supersedes: ['b'] }),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
    ])
    expect(s.current.map(r => r.id)).toEqual(['b'])
  })

  it('revoking ANY record kills the whole chain — no resurrection', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      tomb('t1', 'b'),
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

  it('unknown-kind record still participates in topology (its supersedes edge works)', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('f', '2026-01-02T00:00:00Z', { kind: 'paragraph' as ReviewRecord['kind'], supersedes: ['a'] }),
    ])
    expect(s.current.map(r => r.id)).toEqual(['f'])
  })

  it('unparseable createdAt sorts lowest, never NaN-poisons the tie-break', () => {
    const s = resolveChains([
      rec('a', 'garbage'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['x'] }),
    ])
    expect(s.current).toHaveLength(2)
  })

  it('isTombstone discriminates', () => {
    expect(isTombstone(tomb('t', 'a'))).toBe(true)
    expect(isTombstone(rec('a', '2026-01-01T00:00:00Z'))).toBe(false)
  })
})

describe('resolveChains — revocation cannot be vetoed by foreign records', () => {
  it('a cross-author record unioned via an absent ancestor id does not disable my tombstone', () => {
    // A0 absent (e.g. destroyed by a crafted id collision); my A1 supersedes it,
    // attacker record C (other author) also names it. My unvouch of A1 must hold.
    const a1 = rec('A1', '2026-01-02T00:00:00Z', { supersedes: ['A0'] })
    const c = rec('C', '2026-01-03T00:00:00Z', { author: OTHER, supersedes: ['A0'] })
    const t = tomb('t', 'A1')
    const s = resolveChains([a1, c, t])
    expect(s.current.map(r => r.id)).not.toContain('A1')
  })

  it('my tombstone never kills a foreign record sharing the chain', () => {
    const a1 = rec('A1', '2026-01-02T00:00:00Z', { supersedes: ['A0'] })
    const c = rec('C', '2026-01-03T00:00:00Z', { author: OTHER, supersedes: ['A0'] })
    const s = resolveChains([a1, c, tomb('t', 'A1')])
    expect(s.current.map(r => r.id)).toContain('C')
  })

  it('two authors unioned via a shared absent ancestor both stay current, regardless of createdAt', () => {
    const mine = rec('A1', '2026-01-02T00:00:00Z', { supersedes: ['A0'] })
    const later = rec('C', '9999-01-01T00:00:00Z', { author: OTHER, supersedes: ['A0'] })
    const earlier = rec('C', '2000-01-01T00:00:00Z', { author: OTHER, supersedes: ['A0'] })
    for (const foreign of [later, earlier]) {
      const s = resolveChains([mine, foreign])
      expect(s.chains.size).toBe(1)
      expect(s.current.map(r => r.id).sort()).toEqual(['A1', 'C'])
    }
  })

  it('per-author tips: each author\'s own supersede lineage still resolves inside a shared chain', () => {
    const mineOld = rec('A1', '2026-01-01T00:00:00Z', { supersedes: ['A0'] })
    const mineNew = rec('A2', '2026-01-02T00:00:00Z', { supersedes: ['A1'] })
    const theirs = rec('C', '9999-01-01T00:00:00Z', { author: OTHER, supersedes: ['A0'] })
    const s = resolveChains([mineOld, mineNew, theirs])
    expect(s.current.map(r => r.id).sort()).toEqual(['A2', 'C'])
  })
})
