import { describe, it, expect } from 'vitest'
import { aggregateEngineers } from '../../src/core/engineers'
import type { EngineerSummary } from '../../src/core/store'

const SAN = { name: 'San', email: 's@x.com' }
const BOB = { name: 'Bob', email: 'b@x.com' }

describe('aggregateEngineers (multi-root)', () => {
  it('single root: passes summaries through, tagging each file with that root', () => {
    const rootA = { id: 'A' }
    const summaries: Record<string, EngineerSummary[]> = {
      A: [
        {
          name: SAN.name,
          email: SAN.email,
          reviewCount: 2,
          files: [{ sourcePath: 'src/a.ts', count: 2 }],
        },
      ],
    }
    const out = aggregateEngineers([rootA], (r) => summaries[r.id]!)
    expect(out).toEqual([
      {
        name: SAN.name,
        email: SAN.email,
        reviewCount: 2,
        files: [{ root: rootA, sourcePath: 'src/a.ts', count: 2 }],
      },
    ])
  })

  it('same-named path in two roots yields two distinct, correctly-tagged file entries', () => {
    const rootA = { id: 'A' }
    const rootB = { id: 'B' }
    const summaries: Record<string, EngineerSummary[]> = {
      A: [
        {
          name: SAN.name,
          email: SAN.email,
          reviewCount: 1,
          files: [{ sourcePath: 'src/shared.ts', count: 1 }],
        },
      ],
      B: [
        {
          name: SAN.name,
          email: SAN.email,
          reviewCount: 3,
          files: [{ sourcePath: 'src/shared.ts', count: 3 }],
        },
      ],
    }
    const out = aggregateEngineers([rootA, rootB], (r) => summaries[r.id]!)
    expect(out).toHaveLength(1)
    const san = out[0]!
    // Identity aggregated by email: reviewCount summed across roots.
    expect(san.reviewCount).toBe(4)
    // But the per-file root tags stay distinct — this is the bug fix: each
    // row carries its own root instead of both collapsing into a guess.
    expect(san.files).toEqual([
      { root: rootA, sourcePath: 'src/shared.ts', count: 1 },
      { root: rootB, sourcePath: 'src/shared.ts', count: 3 },
    ])
    // The two entries must be distinguishable by root identity, not just by
    // sourcePath (which is identical for both).
    expect(san.files[0]!.root).toBe(rootA)
    expect(san.files[1]!.root).toBe(rootB)
  })

  it('aggregates distinct engineers by email across roots and sorts by reviewCount desc', () => {
    const rootA = { id: 'A' }
    const rootB = { id: 'B' }
    const summaries: Record<string, EngineerSummary[]> = {
      A: [
        {
          name: BOB.name,
          email: BOB.email,
          reviewCount: 1,
          files: [{ sourcePath: 'src/b.ts', count: 1 }],
        },
      ],
      B: [
        {
          name: SAN.name,
          email: SAN.email,
          reviewCount: 5,
          files: [{ sourcePath: 'src/a.ts', count: 5 }],
        },
      ],
    }
    const out = aggregateEngineers([rootA, rootB], (r) => summaries[r.id]!)
    expect(out.map((e) => e.email)).toEqual([SAN.email, BOB.email])
  })

  it('no roots → empty', () => {
    expect(aggregateEngineers<{ id: string }>([], () => [])).toEqual([])
  })
})

describe('aggregateEngineers — identity normalization across roots', () => {
  it('merges case-differing emails from different roots into one reviewer', () => {
    const rootA = { id: 'A' }
    const rootB = { id: 'B' }
    const out = aggregateEngineers([rootA, rootB], (root) =>
      root === rootA
        ? [
            {
              name: 'Alice',
              email: 'Alice@Example.com',
              reviewCount: 2,
              files: [{ sourcePath: 'a.ts', count: 2 }],
            },
          ]
        : [
            {
              name: 'Alice',
              email: 'alice@example.com',
              reviewCount: 1,
              files: [{ sourcePath: 'b.ts', count: 1 }],
            },
          ],
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.reviewCount).toBe(3)
    expect(out[0]!.files).toHaveLength(2)
  })
})
