import { countLines } from './text'
import type { Resolution } from './anchor'
import type { ReviewRecord } from './types'

export interface FileCoverage { reviewedLines: number; totalLines: number }

export function fileCoverage(
  resolved: { record: ReviewRecord; res: Resolution }[], docText: string,
): FileCoverage | null {
  const totalLines = countLines(docText)
  if (totalLines === 0) return null
  if (resolved.some(e => e.record.kind === 'file' && e.res.status === 'reviewed')) {
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

export function pct(c: FileCoverage): number {
  return Math.round((100 * c.reviewedLines) / c.totalLines)
}
