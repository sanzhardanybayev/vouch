import { countLines } from './text'
import type { Resolution } from './anchor'
import type { ReviewRecord } from './types'

export interface FileCoverage {
  reviewedLines: number
  totalLines: number
}

export function fileCoverage(
  resolved: { record: ReviewRecord; res: Resolution }[],
  docText: string,
): FileCoverage | null {
  const totalLines = countLines(docText)
  if (totalLines === 0) return null
  if (resolved.some((e) => e.record.kind === 'file' && e.res.status === 'reviewed')) {
    return { reviewedLines: totalLines, totalLines }
  }
  const covered = new Set<number>()
  for (const { res } of resolved) {
    if (res.status !== 'reviewed') continue
    const start = Math.max(1, res.effectiveRange[0])
    const end = Math.min(totalLines, res.effectiveRange[1])
    for (let l = start; l <= end; l++) covered.add(l)
  }
  return { reviewedLines: covered.size, totalLines }
}

export function rollup(children: (FileCoverage | null)[]): FileCoverage | null {
  let reviewedLines = 0
  let totalLines = 0
  let any = false
  for (const c of children) {
    if (!c) continue
    any = true
    reviewedLines += c.reviewedLines
    totalLines += c.totalLines
  }
  return any ? { reviewedLines, totalLines } : null
}

// Honest at the edges: 100 only when every line is reviewed, 0 only when
// none is — a rounded 99.96% must not display as the green-mark-never-lies
// hundred, and one reviewed line is not "0%".
export function pct(c: FileCoverage): number {
  if (c.reviewedLines >= c.totalLines) return 100
  if (c.reviewedLines <= 0) return 0
  return Math.min(99, Math.max(1, Math.round((100 * c.reviewedLines) / c.totalLines)))
}
