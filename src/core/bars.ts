import type { Status } from './anchor'

/**
 * Which status needs attention first when several reviews meet on one line:
 * dismissed (needs a re-review), then ambiguous (needs resolving), then
 * reviewed. Used for gutter icons on a shared first line and, among reviews
 * that do not verify, for range bars.
 */
export const ATTENTION: Record<Status, number> = { reviewed: 0, ambiguous: 1, dismissed: 2 }

/** The status that needs attention first of the two. */
export function mostUrgent(a: Status, b: Status): Status {
  return ATTENTION[b] > ATTENTION[a] ? b : a
}

/**
 * Flatten possibly overlapping review spans into disjoint runs of one status
 * each. Ranges are 1-based inclusive and come from shared, untrusted records:
 * they are clamped to [1, lineCount] and non-finite or inverted ranges are
 * dropped.
 *
 * A line that a reviewed span covers is reviewed: that review verifies the
 * text as it is now. A dismissed or ambiguous span only says where some text
 * used to be (a whole changed file, or the stale stored range of code that
 * moved), so it must not paint over code another review still vouches for.
 * Every other line takes the status that needs attention first.
 */
export function lineStatuses(
  spans: { status: Status; range: [number, number] }[],
  lineCount: number,
): { status: Status; range: [number, number] }[] {
  if (lineCount < 1 || spans.length === 0) return []
  const at: (Status | undefined)[] = new Array<Status | undefined>(lineCount + 1)
  for (const { status, range } of spans) {
    if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) continue
    const start = Math.max(1, Math.floor(range[0]))
    const end = Math.min(lineCount, Math.floor(range[1]))
    for (let l = start; l <= end; l++) {
      const prev = at[l]
      at[l] =
        prev === undefined
          ? status
          : prev === 'reviewed' || status === 'reviewed'
            ? 'reviewed'
            : mostUrgent(prev, status)
    }
  }
  const out: { status: Status; range: [number, number] }[] = []
  for (let l = 1; l <= lineCount; l++) {
    const s = at[l]
    if (s === undefined) continue
    const last = out[out.length - 1]
    if (last && last.range[1] === l - 1 && last.status === s) last.range[1] = l
    else out.push({ status: s, range: [l, l] })
  }
  return out
}
