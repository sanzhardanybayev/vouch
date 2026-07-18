import { hashRangeOfText, type Resolution } from './anchor'
import { normalizeEol, sha256 } from './text'
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
    .filter(e => e.record.author.email === params.author.email)
    .filter(e => {
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
  range?: [number, number]
  docText: string
  comment?: string
  existingCurrent: { record: ReviewRecord; res: Resolution }[]
}): ReviewRecord {
  const { kind, range, docText } = params

  const superseded = supersedeCandidates(params).map(e => e.record.id)

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
  }
  if (params.symbol) rec.symbol = params.symbol
  if (params.comment) rec.comment = params.comment
  if (superseded.length > 0) rec.supersedes = superseded
  return rec
}

export function buildReattachLines(
  records: ReviewRecord[], newSourcePath: string,
  idGen: () => string, nowIso: string, reattachedBy: Author,
): { copies: ReviewRecord[]; tombstones: Tombstone[] } {
  const copies: ReviewRecord[] = []
  const tombstones: Tombstone[] = []
  for (const r of records) {
    copies.push({ ...r, id: idGen(), movedFrom: r.id, supersedes: undefined })
    tombstones.push({ id: idGen(), author: reattachedBy, createdAt: nowIso,
      revokes: r.id, reason: 'moved', movedTo: newSourcePath })
  }
  return { copies, tombstones }
}
