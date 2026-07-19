import { hashLines, normalizeEol, sha256, splitLines } from './text'
import type { ReviewRecord } from './types'

export function baselineSlice(
  committedText: string,
  record: ReviewRecord,
): { text: string; verified: boolean } {
  if (record.kind === 'file') {
    return { text: committedText, verified: sha256(normalizeEol(committedText)) === record.hash }
  }
  const lines = splitLines(committedText)
  const [s, e] = record.range ?? [1, 1]
  if (s < 1 || e > lines.length) return { text: committedText, verified: false }
  const slice = lines.slice(s - 1, e)
  if (hashLines(slice) === record.hash) return { text: slice.join('\n'), verified: true }
  return { text: committedText, verified: false }
}
