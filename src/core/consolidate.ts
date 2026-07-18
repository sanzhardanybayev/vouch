import type { Resolution } from './anchor'
import type { ReviewRecord } from './types'

export interface ConsolidationSummary {
  total: number
  dismissed: number
  withComments: number
}

export function summarizeCandidates(
  candidates: { record: ReviewRecord; res: Resolution }[],
): ConsolidationSummary {
  return {
    total: candidates.length,
    dismissed: candidates.filter(c => c.res.status === 'dismissed').length,
    withComments: candidates.filter(c => c.record.comment).length,
  }
}

// Labels come from record FIELDS only; comments stay inert text (records are untrusted)
function label(rec: ReviewRecord): string {
  const seg = rec.symbol?.split('/').pop()
  if (seg && rec.range) return `${seg} (was L${rec.range[0]}-${rec.range[1]})`
  if (rec.range) return `L${rec.range[0]}-${rec.range[1]}`
  return 'file'
}

export function prefillComment(
  candidates: { record: ReviewRecord; res: Resolution }[],
): string {
  return candidates
    .filter(c => c.record.comment)
    .sort((a, b) => (a.record.range?.[0] ?? 0) - (b.record.range?.[0] ?? 0))
    .map(c => `> ${label(c.record)}: ${c.record.comment}`)
    .join(' | ')
}
