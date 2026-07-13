import { describe, it, expect } from 'vitest'
import { buildTree, headerStats, type TreeFile } from '../../src/core/treemodel'

const FILES: TreeFile[] = [
  { path: 'src/a.ts', coverage: { reviewedLines: 5, totalLines: 10 } },
  { path: 'src/sub/b.ts', coverage: { reviewedLines: 10, totalLines: 10 } },
  { path: 'src/c.ts', coverage: null },          // no records
  { path: 'README.md', coverage: null },
]

describe('buildTree', () => {
  it('nests folders and rolls up attested descendants only', () => {
    const root = buildTree(FILES)
    const src = root.folders.find(f => f.name === 'src')!
    expect(src.files.map(f => f.path).sort()).toEqual(['src/a.ts', 'src/c.ts'])
    expect(src.folders[0]!.name).toBe('sub')
    expect(src.coverage).toEqual({ reviewedLines: 15, totalLines: 20 }) // c.ts excluded
    expect(root.files.map(f => f.path)).toEqual(['README.md'])
    expect(root.coverage).toEqual({ reviewedLines: 15, totalLines: 20 })
  })
  it('pending descendant → pending folder', () => {
    const root = buildTree([{ path: 'src/a.ts', coverage: 'pending' },
      { path: 'src/b.ts', coverage: { reviewedLines: 1, totalLines: 2 } }])
    expect(root.folders[0]!.coverage).toBe('pending')
    expect(root.coverage).toBe('pending')
  })
  it('all-null tree → null coverage (no NaN)', () => {
    const root = buildTree([{ path: 'a.ts', coverage: null }])
    expect(root.coverage).toBeNull()
  })
})

describe('headerStats', () => {
  it('computes workspace pct over attested files and counts', () => {
    const counts = { records: 3, perAuthor: new Map([['s@x.com', { name: 'San', current: 3 }]]) }
    const h = headerStats(FILES, 42, counts)
    expect(h.workspacePct).toBe(75) // 15/20
    expect(h.pending).toBe(false)
    expect(h.attested).toBe(2)
    expect(h.totalFiles).toBe(42)
    expect(h.perAuthor).toEqual([{ name: 'San', current: 3 }])
  })
  it('pending propagates; no attested files → null pct', () => {
    expect(headerStats([{ path: 'a', coverage: 'pending' }], 1,
      { records: 0, perAuthor: new Map() }).pending).toBe(true)
    expect(headerStats([{ path: 'a', coverage: null }], 1,
      { records: 0, perAuthor: new Map() }).workspacePct).toBeNull()
  })
})
