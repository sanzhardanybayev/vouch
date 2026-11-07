import type { TreeFile, TreeFolder } from './treemodel'
import { normalizeEmail } from './paths'

/** View-only narrowing of the coverage tree. Never touches coverage math:
 * folder percentages stay those of the full universe. */
export interface TreeFilter {
  /** Hide files nobody currently vouches for (0% coverage, no reviews). */
  hideUnreviewed: boolean
  /** Normalized email; null = every reviewer. */
  reviewer: string | null
  /** Regex source matched against the repo-relative path; '' = off. */
  pathRegex: string
}

export const DEFAULT_FILTER: TreeFilter = { hideUnreviewed: true, reviewer: null, pathRegex: '' }

export const MAX_PATH_REGEX = 500

export type PathMatcher = { ok: true; test: (p: string) => boolean } | { ok: false; error: string }

export function compilePathFilter(src: string): PathMatcher {
  if (src === '') return { ok: true, test: () => true }
  if (src.length > MAX_PATH_REGEX) {
    return { ok: false, error: `regex longer than ${MAX_PATH_REGEX} characters` }
  }
  try {
    const re = new RegExp(src)
    return { ok: true, test: (p) => re.test(p) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Whether a filter narrows anything (the default hides unreviewed files). */
export function isNarrowing(f: TreeFilter): boolean {
  return f.hideUnreviewed || f.reviewer !== null || f.pathRegex !== ''
}

/**
 * Per-file predicate. `reviewersOf` returns the normalized emails of the
 * authors of the file's CURRENT reviews (empty for a never-reviewed file).
 * A file whose reviews are all dismissed reads 0% but still has reviewers:
 * it stays visible, since it is exactly the code waiting for a re-review.
 * An invalid regex filters nothing rather than hiding the whole tree.
 */
export function fileMatcher(
  f: TreeFilter,
  reviewersOf: (path: string) => string[],
): (file: TreeFile) => boolean {
  const pathOk = compilePathFilter(f.pathRegex)
  const testPath = pathOk.ok ? pathOk.test : (): boolean => true
  const reviewer = f.reviewer === null ? null : normalizeEmail(f.reviewer)
  return (file) => {
    if (!testPath(file.path)) return false
    if (!f.hideUnreviewed && reviewer === null) return true
    const who = reviewersOf(file.path)
    if (f.hideUnreviewed && who.length === 0) return false
    return reviewer === null || who.includes(reviewer)
  }
}

/** Copy of the tree keeping only matching files and the folders that still
 * hold one; coverage values are carried over untouched. */
export function pruneTree(folder: TreeFolder, keep: (f: TreeFile) => boolean): TreeFolder {
  const folders = folder.folders
    .map((sub) => pruneTree(sub, keep))
    .filter((sub) => sub.folders.length > 0 || sub.files.length > 0)
  return { ...folder, folders, files: folder.files.filter(keep) }
}

/** Parse persisted/webview input into a filter; anything malformed falls
 * back to the default for that field. */
export function sanitizeFilter(raw: unknown): TreeFilter {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    hideUnreviewed:
      typeof o.hideUnreviewed === 'boolean' ? o.hideUnreviewed : DEFAULT_FILTER.hideUnreviewed,
    reviewer:
      typeof o.reviewer === 'string' && o.reviewer !== '' ? normalizeEmail(o.reviewer) : null,
    pathRegex: typeof o.pathRegex === 'string' ? o.pathRegex.slice(0, MAX_PATH_REGEX) : '',
  }
}
