import { describe, it, expect } from 'vitest'
import { buildReattachLines } from '../../src/core/attest'
import type { ReviewRecord } from '../../src/core/types'

const SAN = { name: 'San', email: 's@x.com' }
const BOB = { name: 'Bob', email: 'b@x.com' }
const NOW = '2026-07-13T12:00:00Z'

const RECORDS: ReviewRecord[] = [
  {
    id: 'a1',
    author: SAN,
    createdAt: '2026-01-01T00:00:00Z',
    commit: 'c1',
    dirty: false,
    kind: 'function',
    symbol: 'f',
    range: [1, 3],
    hash: 'sha256:h1',
    headHash: 'sha256:hh1',
    comment: 'ok',
  },
  {
    id: 'b1',
    author: BOB,
    createdAt: '2026-02-01T00:00:00Z',
    commit: 'c2',
    dirty: true,
    kind: 'selection',
    range: [5, 6],
    hash: 'sha256:h2',
    headHash: 'sha256:hh2',
  },
]

describe('buildReattachLines', () => {
  it('copies preserve author/createdAt/hash and link movedFrom; tombstones mark moved', () => {
    let n = 0
    const { copies, tombstones } = buildReattachLines(
      RECORDS,
      'src/new.ts',
      () => `id${n++}`,
      NOW,
      SAN,
    )

    expect(copies).toHaveLength(2)
    expect(copies[0]).toMatchObject({
      id: 'id0',
      movedFrom: 'a1',
      author: SAN,
      createdAt: '2026-01-01T00:00:00Z',
      hash: 'sha256:h1',
      headHash: 'sha256:hh1',
      comment: 'ok',
      kind: 'function',
      symbol: 'f',
    })
    expect(copies[1]!.author).toEqual(BOB) // authorship preserved, not re-attacher

    expect(tombstones).toHaveLength(2)
    expect(tombstones[0]).toMatchObject({
      revokes: 'a1',
      reason: 'moved',
      movedTo: 'src/new.ts',
      author: SAN,
      createdAt: NOW,
    })
    expect(tombstones[0]!.id).not.toBe(copies[0]!.id)
  })
})
