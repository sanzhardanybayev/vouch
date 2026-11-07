import type { Status } from './anchor'

// Precedence where reviews overlap: a dismissed span needs action first, an
// unresolved ambiguity second, a green span last - a bar must never paint
// green over a line that a dismissed review also covers.
const RANK: Record<Status, number> = { reviewed: 1, ambiguous: 2, dismissed: 3 }
const BY_RANK: Status[] = ['reviewed', 'reviewed', 'ambiguous', 'dismissed']

/**
 * Flatten possibly overlapping review spans into disjoint runs of one status
 * each, highest-precedence status winning per line. Ranges are 1-based
 * inclusive and come from shared, untrusted records: they are clamped to
 * [1, lineCount] and non-finite or inverted ranges are dropped.
 */
export function lineStatuses(
  spans: { status: Status; range: [number, number] }[],
  lineCount: number,
): { status: Status; range: [number, number] }[] {
  if (lineCount < 1 || spans.length === 0) return []
  const rank = new Uint8Array(lineCount + 1)
  for (const { status, range } of spans) {
    if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) continue
    const start = Math.max(1, Math.floor(range[0]))
    const end = Math.min(lineCount, Math.floor(range[1]))
    const r = RANK[status]
    for (let l = start; l <= end; l++) if (rank[l]! < r) rank[l] = r
  }
  const out: { status: Status; range: [number, number] }[] = []
  for (let l = 1; l <= lineCount; l++) {
    const r = rank[l]!
    if (r === 0) continue
    const last = out[out.length - 1]
    if (last && last.range[1] === l - 1 && RANK[last.status] === r) last.range[1] = l
    else out.push({ status: BY_RANK[r]!, range: [l, l] })
  }
  return out
}
