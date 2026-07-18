import { describe, it, expect } from 'vitest'
import { prefillComment, summarizeCandidates } from '../../src/core/consolidate'
import type { Resolution, Status } from '../../src/core/anchor'
import type { ReviewRecord } from '../../src/core/types'

const AUTHOR = { name: 'S', email: 's@x.com' }

function candidate(opts: {
  id: string
  kind?: ReviewRecord['kind']
  symbol?: string
  range?: [number, number]
  comment?: string
  status?: Status
}): { record: ReviewRecord; res: Resolution } {
  const record: ReviewRecord = {
    id: opts.id, author: AUTHOR, createdAt: '2026-01-01T00:00:00Z', commit: 'c1',
    dirty: false, kind: opts.kind ?? 'selection', hash: 'sha256:x',
  }
  if (opts.symbol) record.symbol = opts.symbol
  if (opts.range) record.range = opts.range
  if (opts.comment) record.comment = opts.comment
  const res: Resolution = {
    status: opts.status ?? 'reviewed',
    effectiveRange: opts.range ?? [1, 1],
  }
  return { record, res }
}

describe('summarizeCandidates', () => {
  it('empty input yields zeros', () => {
    expect(summarizeCandidates([])).toEqual({ total: 0, dismissed: 0, withComments: 0 })
  })

  it('counts totals, dismissed, and commented candidates', () => {
    const cands = [
      candidate({ id: 'a', range: [1, 2], comment: 'looks fine' }),
      candidate({ id: 'b', range: [3, 4], status: 'dismissed' }),
      candidate({ id: 'c', range: [5, 6], status: 'dismissed', comment: 'stale' }),
    ]
    expect(summarizeCandidates(cands)).toEqual({ total: 3, dismissed: 2, withComments: 2 })
  })
})

describe('prefillComment', () => {
  it('empty input yields empty string', () => {
    expect(prefillComment([])).toBe('')
  })

  it('skips candidates without a comment', () => {
    const cands = [
      candidate({ id: 'a', range: [1, 2] }),
      candidate({ id: 'b', range: [3, 4], comment: 'checked' }),
    ]
    expect(prefillComment(cands)).toBe('> L3-4: checked')
  })

  it('uses the last symbol segment with the stored range', () => {
    const cands = [
      candidate({ id: 'a', kind: 'function', symbol: 'AuthService/login',
        range: [5, 8], comment: 'auth ok' }),
    ]
    expect(prefillComment(cands)).toBe('> login (was L5-8): auth ok')
  })

  it('uses file label for kind=file records without a range', () => {
    const cands = [
      candidate({ id: 'a', kind: 'file', comment: 'whole file fine' }),
    ]
    expect(prefillComment(cands)).toBe('> file: whole file fine')
  })

  it('sorts by record range start and joins with pipe separator', () => {
    const cands = [
      candidate({ id: 'b', range: [4, 6], comment: 'second' }),
      candidate({ id: 'c', kind: 'file', comment: 'file note' }),
      candidate({ id: 'a', kind: 'function', symbol: 'Svc/run', range: [1, 3], comment: 'first' }),
    ]
    expect(prefillComment(cands)).toBe(
      '> file: file note | > run (was L1-3): first | > L4-6: second')
  })

  it('keeps pipe and angle characters in comments untransformed', () => {
    const cands = [
      candidate({ id: 'a', range: [1, 2], comment: 'a | b > c' }),
      candidate({ id: 'b', range: [3, 4], comment: 'plain' }),
    ]
    expect(prefillComment(cands)).toBe('> L1-2: a | b > c | > L3-4: plain')
  })
})
