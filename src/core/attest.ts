import { hashRangeOfText, type Resolution } from './anchor'
import { normalizeEol, sha256 } from './text'
import type { Author, RecordKind, ReviewRecord } from './types'

export function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
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

  const mine = params.existingCurrent.filter(
    e => e.record.author.email === params.author.email)
  const superseded = mine.filter(e => {
    if (kind === 'file') return true
    if (params.symbol && e.record.symbol === params.symbol) return true
    return range ? overlaps(e.res.effectiveRange, range) : false
  }).map(e => e.record.id)

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
