import { ctxHashes, hashRangeOfText, type Resolution } from './anchor'
import { hashLines, normalizeEol, sha256, splitLines } from './text'
import { normalizeEmail } from './paths'
import type { Author, RecordKind, ReviewRecord, Tombstone } from './types'

export function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

export function encloses(outer: [number, number], inner: [number, number]): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1]
}

// Supersede trigger (ADR 0001): full enclosure only, never partial overlap.
export function supersedeCandidates(params: {
  author: Author
  kind: RecordKind
  symbol?: string
  range?: [number, number]
  existingCurrent: { record: ReviewRecord; res: Resolution }[]
}): { record: ReviewRecord; res: Resolution }[] {
  const { kind, symbol, range } = params
  return params.existingCurrent
    .filter((e) => normalizeEmail(e.record.author.email) === normalizeEmail(params.author.email))
    .filter((e) => {
      if (kind === 'file') return true
      if (symbol && e.record.symbol === symbol) return true
      return range ? encloses(range, e.res.effectiveRange) : false
    })
}

export function buildRecord(params: {
  id: string
  author: Author
  createdAt: string
  commit: string
  dirty: boolean
  kind: RecordKind
  symbol?: string
  anchorSymbol?: string
  range?: [number, number]
  docText: string
  comment?: string
  /** Explicit supersede target (threaded from re-review/resolve flows).
   * Honored only while it still names a current, same-author record. */
  supersedeId?: string
  /** Supersede ONLY the explicit supersedeId, skipping the enclosure
   * heuristic. The resolve flow replaces one specific ambiguous record; the
   * picked range enclosing an unrelated nested review must never silently
   * revoke it (that path has no confirmation modal, unlike attest). */
  explicitSupersedeOnly?: boolean
  existingCurrent: { record: ReviewRecord; res: Resolution }[]
}): ReviewRecord {
  const { kind, range, docText } = params

  const superseded = params.explicitSupersedeOnly
    ? []
    : supersedeCandidates(params).map((e) => e.record.id)
  if (params.supersedeId && !superseded.includes(params.supersedeId)) {
    const target = params.existingCurrent.find(
      (e) =>
        e.record.id === params.supersedeId &&
        normalizeEmail(e.record.author.email) === normalizeEmail(params.author.email),
    )
    if (target) superseded.push(target.record.id)
  }

  const rec: ReviewRecord = {
    id: params.id,
    author: params.author,
    createdAt: params.createdAt,
    commit: params.commit,
    dirty: params.dirty,
    kind,
    hash: '',
  }
  if (kind === 'file') {
    rec.hash = sha256(normalizeEol(docText))
  } else {
    const r = range!
    const { hash, headHash } = hashRangeOfText(docText, r)
    rec.hash = hash
    rec.headHash = headHash
    rec.range = r
    const ctx = ctxHashes(splitLines(docText), r)
    rec.ctxBefore = ctx.before
    rec.ctxAfter = ctx.after
  }
  if (params.symbol) rec.symbol = params.symbol
  // anchorSymbol is a separate field from symbol on purpose: symbol on a
  // record means "this record covers that whole function/class" (supersede
  // semantics, re-review escalation); a selection's enclosing symbol is pure
  // location identity and must never be read as a coverage claim - including
  // by 0.0.2 clients sharing the repo.
  if (kind === 'selection' && params.anchorSymbol !== undefined) {
    rec.anchorSymbol = params.anchorSymbol
  }
  if (params.comment) rec.comment = params.comment
  if (superseded.length > 0) rec.supersedes = superseded
  return rec
}

/**
 * Content-anchored post-dialog guard: locate the snapshot selection's exact
 * content in the final buffer text. Returns the rebased range when it exists
 * exactly once (insertions elsewhere never block an attest), or null when the
 * content was edited away or duplicated while a dialog was open - the caller
 * must abort rather than hash text the user never read.
 */
export function rebaseRange(
  snapshotText: string,
  range: [number, number],
  finalText: string,
): [number, number] | null {
  const { hash, headHash } = hashRangeOfText(snapshotText, range)
  const lines = splitLines(finalText)
  const len = range[1] - range[0] + 1
  if (!Number.isInteger(len) || len < 1) return null
  let found: number | null = null
  for (let i = 0; i + len <= lines.length; i++) {
    if (sha256(lines[i]!) !== headHash) continue
    if (hashLines(lines.slice(i, i + len)) !== hash) continue
    if (found !== null) return null // duplicated while dialog was open
    found = i
  }
  return found === null ? null : [found + 1, found + len]
}

export function buildReattachLines(
  records: ReviewRecord[],
  newSourcePath: string,
  idGen: () => string,
  nowIso: string,
  reattachedBy: Author,
): { copies: ReviewRecord[]; tombstones: Tombstone[] } {
  const copies: ReviewRecord[] = []
  const tombstones: Tombstone[] = []
  for (const r of records) {
    copies.push({ ...r, id: idGen(), movedFrom: r.id, supersedes: undefined })
    tombstones.push({
      id: idGen(),
      author: reattachedBy,
      createdAt: nowIso,
      revokes: r.id,
      reason: 'moved',
      movedTo: newSourcePath,
    })
  }
  return { copies, tombstones }
}
