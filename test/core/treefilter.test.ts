import { describe, it, expect } from 'vitest'
import { buildTree, type TreeFile } from '../../src/core/treemodel'
import {
  DEFAULT_FILTER,
  compilePathFilter,
  fileMatcher,
  isNarrowing,
  pruneTree,
  sanitizeFilter,
  MAX_PATH_REGEX,
} from '../../src/core/treefilter'

const FILES: TreeFile[] = [
  { path: 'src/core/a.ts', coverage: { reviewedLines: 5, totalLines: 10 }, reviewed: true },
  { path: 'src/core/b.ts', coverage: { reviewedLines: 0, totalLines: 10 }, reviewed: false },
  { path: 'src/vscode/c.ts', coverage: { reviewedLines: 0, totalLines: 4 }, reviewed: true },
  { path: 'test/core/a.test.ts', coverage: { reviewedLines: 0, totalLines: 6 }, reviewed: false },
]
const REVIEWERS: Record<string, string[]> = {
  'src/core/a.ts': ['ann@x.dev'],
  // every review dismissed: 0%, but the reviewer still stands on record
  'src/vscode/c.ts': ['bob@x.dev'],
}
const reviewersOf = (p: string): string[] => REVIEWERS[p] ?? []
const paths = (keep: (f: TreeFile) => boolean): string[] => FILES.filter(keep).map((f) => f.path)

describe('fileMatcher', () => {
  it('default hides never-reviewed files but keeps dismissed-only ones', () => {
    expect(paths(fileMatcher(DEFAULT_FILTER, reviewersOf))).toEqual([
      'src/core/a.ts',
      'src/vscode/c.ts',
    ])
  })

  it('everything visible with hideUnreviewed off', () => {
    const f = { ...DEFAULT_FILTER, hideUnreviewed: false }
    expect(paths(fileMatcher(f, reviewersOf))).toHaveLength(4)
  })

  it('reviewer filter keeps only files that reviewer currently reviews (case-insensitive)', () => {
    const f = { ...DEFAULT_FILTER, hideUnreviewed: false, reviewer: 'Bob@X.dev' }
    expect(paths(fileMatcher(f, reviewersOf))).toEqual(['src/vscode/c.ts'])
  })

  it('path regex narrows by repo-relative path', () => {
    const f = { ...DEFAULT_FILTER, hideUnreviewed: false, pathRegex: '\\.test\\.ts$' }
    expect(paths(fileMatcher(f, reviewersOf))).toEqual(['test/core/a.test.ts'])
    const core = { ...DEFAULT_FILTER, hideUnreviewed: false, pathRegex: '^src/core/' }
    expect(paths(fileMatcher(core, reviewersOf))).toEqual(['src/core/a.ts', 'src/core/b.ts'])
  })

  it('filters combine', () => {
    const f = { hideUnreviewed: true, reviewer: null, pathRegex: 'core' }
    expect(paths(fileMatcher(f, reviewersOf))).toEqual(['src/core/a.ts'])
  })

  it('an invalid regex filters nothing instead of hiding the tree', () => {
    const f = { ...DEFAULT_FILTER, hideUnreviewed: false, pathRegex: '(' }
    expect(paths(fileMatcher(f, reviewersOf))).toHaveLength(4)
  })
})

describe('compilePathFilter', () => {
  it('empty source is off', () => {
    const m = compilePathFilter('')
    expect(m.ok && m.test('anything')).toBe(true)
  })
  it('reports syntax errors', () => {
    const m = compilePathFilter('[a-')
    expect(m.ok).toBe(false)
  })
  it('rejects over-long sources', () => {
    expect(compilePathFilter('a'.repeat(MAX_PATH_REGEX + 1)).ok).toBe(false)
  })
})

describe('pruneTree', () => {
  it('drops emptied folders and keeps full-universe coverage numbers', () => {
    const full = buildTree(FILES)
    const pruned = pruneTree(full, fileMatcher(DEFAULT_FILTER, reviewersOf))
    expect(pruned.folders.map((f) => f.name)).toEqual(['src']) // test/ emptied away
    const src = pruned.folders[0]!
    const core = src.folders.find((f) => f.name === 'core')!
    expect(core.files.map((f) => f.path)).toEqual(['src/core/a.ts'])
    // b.ts is hidden but still counts: the folder reads 5/20, not 5/10.
    expect(core.coverage).toEqual({ reviewedLines: 5, totalLines: 20 })
  })

  it('does not mutate the source tree', () => {
    const full = buildTree(FILES)
    pruneTree(full, () => false)
    expect(full.folders.map((f) => f.name)).toEqual(['src', 'test'])
  })
})

describe('sanitizeFilter / isNarrowing', () => {
  it('malformed input falls back per field', () => {
    expect(sanitizeFilter(undefined)).toEqual(DEFAULT_FILTER)
    expect(sanitizeFilter({ hideUnreviewed: 'yes', reviewer: 7, pathRegex: null })).toEqual(
      DEFAULT_FILTER,
    )
  })
  it('normalizes the reviewer and caps the regex', () => {
    const f = sanitizeFilter({
      hideUnreviewed: false,
      reviewer: ' Ann@X.dev ',
      pathRegex: 'a'.repeat(MAX_PATH_REGEX + 10),
    })
    expect(f.reviewer).toBe('ann@x.dev')
    expect(f.pathRegex).toHaveLength(MAX_PATH_REGEX)
  })
  it('narrowing unless every filter is off', () => {
    expect(isNarrowing(DEFAULT_FILTER)).toBe(true)
    expect(isNarrowing({ hideUnreviewed: false, reviewer: null, pathRegex: '' })).toBe(false)
  })
})
