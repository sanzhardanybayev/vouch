import { describe, it, expect } from 'vitest'
import { buildTree, headerStats, type TreeFile } from '../../src/core/treemodel'

const FILES: TreeFile[] = [
  { path: 'src/a.ts', coverage: { reviewedLines: 5, totalLines: 10 }, reviewed: true },
  { path: 'src/sub/b.ts', coverage: { reviewedLines: 10, totalLines: 10 }, reviewed: true },
  { path: 'src/c.ts', coverage: null, reviewed: false },          // no records
  { path: 'README.md', coverage: null, reviewed: false },
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
    const root = buildTree([{ path: 'src/a.ts', coverage: 'pending', reviewed: false },
      { path: 'src/b.ts', coverage: { reviewedLines: 1, totalLines: 2 }, reviewed: true }])
    expect(root.folders[0]!.coverage).toBe('pending')
    expect(root.coverage).toBe('pending')
  })
  it('all-null tree → null coverage (no NaN)', () => {
    const root = buildTree([{ path: 'a.ts', coverage: null, reviewed: false }])
    expect(root.coverage).toBeNull()
  })
})

describe('headerStats', () => {
  it('computes workspace pct over attested files and counts', () => {
    const counts = { records: 3, perAuthor: new Map([['s@x.com', { name: 'San', current: 3 }]]) }
    const h = headerStats(FILES, 42, counts)
    expect(h.workspacePct).toBe(75) // 15/20
    expect(h.pending).toBe(false)
    expect(h.reviewedFiles).toBe(2)
    expect(h.totalFiles).toBe(42)
    expect(h.perAuthor).toEqual([{ name: 'San', current: 3 }])
  })
  it('pending propagates; no attested files → null pct', () => {
    expect(headerStats([{ path: 'a', coverage: 'pending', reviewed: false }], 1,
      { records: 0, perAuthor: new Map() }).pending).toBe(true)
    expect(headerStats([{ path: 'a', coverage: null, reviewed: false }], 1,
      { records: 0, perAuthor: new Map() }).workspacePct).toBeNull()
  })
})

describe('buildTree honest rollups (v1.1)', () => {
  it('folder % counts unreviewed {0,N} files in the denominator', () => {
    const files: TreeFile[] = [
      { path: 'src/a.ts', coverage: { reviewedLines: 10, totalLines: 10 }, reviewed: true },
      { path: 'src/b.ts', coverage: { reviewedLines: 0, totalLines: 10 }, reviewed: false },
      { path: 'src/c.ts', coverage: { reviewedLines: 0, totalLines: 20 }, reviewed: false },
    ]
    const root = buildTree(files)
    const src = root.folders.find(f => f.name === 'src')!
    // 10 reviewed of 40 total = 25%, NOT 100%
    expect(src.coverage).toEqual({ reviewedLines: 10, totalLines: 40 })
  })

  it('null coverage (excluded) is skipped, not counted as 0-reviewed', () => {
    const files: TreeFile[] = [
      { path: 'src/a.ts', coverage: { reviewedLines: 5, totalLines: 10 }, reviewed: true },
      { path: 'src/logo.png', coverage: null, reviewed: false }, // binary → excluded
    ]
    const root = buildTree(files)
    const src = root.folders.find(f => f.name === 'src')!
    expect(src.coverage).toEqual({ reviewedLines: 5, totalLines: 10 })
  })
})

describe('headerStats (v1.1)', () => {
  it('workspacePct is reviewed lines over ALL counted files; reviewedFiles counts reviewed only', () => {
    const files: TreeFile[] = [
      { path: 'a.ts', coverage: { reviewedLines: 10, totalLines: 10 }, reviewed: true },
      { path: 'b.ts', coverage: { reviewedLines: 0, totalLines: 30 }, reviewed: false },
      { path: 'c.png', coverage: null, reviewed: false },
    ]
    const counts = { records: 2, perAuthor: new Map([['s@x.com', { name: 'San', current: 2 }]]) }
    const h = headerStats(files, 3, counts)
    expect(h.workspacePct).toBe(25) // 10 / 40
    expect(h.reviewedFiles).toBe(1)
    expect(h.totalFiles).toBe(3)
    expect(h.perAuthor).toEqual([{ name: 'San', current: 2 }])
  })

  it('no reviews anywhere → workspacePct 0 when files exist, null when no counted files', () => {
    const counts = { records: 0, perAuthor: new Map() }
    expect(headerStats([{ path: 'a.ts', coverage: { reviewedLines: 0, totalLines: 5 }, reviewed: false }],
      1, counts).workspacePct).toBe(0)
    expect(headerStats([{ path: 'a.png', coverage: null, reviewed: false }], 1, counts).workspacePct).toBeNull()
  })

  it('pending propagates', () => {
    const counts = { records: 0, perAuthor: new Map() }
    expect(headerStats([{ path: 'a.ts', coverage: 'pending', reviewed: false }], 1, counts).pending).toBe(true)
  })
})
