import type { EngineerSummary } from './store'

export interface AggregatedEngineerFile<R> { root: R; sourcePath: string; count: number }
export interface AggregatedEngineer<R> {
  name: string
  email: string
  reviewCount: number
  files: AggregatedEngineerFile<R>[]
}

// Aggregates per-root EngineerSummary lists into one list keyed by email,
// while tagging every file entry with the root it came from. This is the
// piece that matters for multi-root workspaces: a naive merge (just
// concatenating `.files` arrays) loses which root each file belongs to, so a
// consumer is later forced to *guess* the root back (e.g. "first root that
// has a record for this path"), which silently opens the wrong file when two
// roots share a same-named path. Carrying the root through aggregation makes
// that guess unnecessary — a same-named file in two roots simply yields two
// distinct file entries, each with its own root.
//
// Generic over the root type `R` so this can be unit tested with plain
// objects, independent of the vscode-specific RootEntry shape.
export function aggregateEngineers<R>(
  roots: R[],
  summariesOf: (root: R) => EngineerSummary[],
): AggregatedEngineer<R>[] {
  const byEmail = new Map<string, AggregatedEngineer<R>>()
  for (const root of roots) {
    for (const e of summariesOf(root)) {
      const taggedFiles = e.files.map(f => ({ root, sourcePath: f.sourcePath, count: f.count }))
      const ex = byEmail.get(e.email)
      if (!ex) byEmail.set(e.email, { name: e.name, email: e.email, reviewCount: e.reviewCount, files: taggedFiles })
      else { ex.reviewCount += e.reviewCount; ex.files.push(...taggedFiles) }
    }
  }
  return [...byEmail.values()].sort((a, b) => b.reviewCount - a.reviewCount || a.name.localeCompare(b.name))
}
