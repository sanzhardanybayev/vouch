import { enclosingSymbolOfRange, type Resolution, type SymbolNode } from './anchor'
import { overlaps } from './attest'
import type { ReviewRecord } from './types'

/**
 * Effective line span of a call target. Definition providers that answer with
 * a plain Location give only the identifier's lines (identifierOnly), so a
 * review covering the function body but not the signature line would never
 * overlap it — expand to the deepest enclosing symbol when one is known.
 */
export function callTargetSpan(
  span: [number, number],
  identifierOnly: boolean,
  symbols: SymbolNode[] | null,
): [number, number] {
  if (!identifierOnly || !symbols) return span
  return enclosingSymbolOfRange(symbols, span, 'any')?.range ?? span
}

/** Records covering a line span: file-kind always, others by overlap. */
export function coveringEntries<E extends { record: ReviewRecord; res: Resolution }>(
  entries: E[],
  span: [number, number],
): E[] {
  return entries.filter((e) => e.record.kind === 'file' || overlaps(e.res.effectiveRange, span))
}
