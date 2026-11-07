import { describe, it, expect } from 'vitest'
import { lineStatuses, mostUrgent } from '../../src/core/bars'

describe('lineStatuses', () => {
  it('one span -> one run covering its whole range', () => {
    expect(lineStatuses([{ status: 'reviewed', range: [3, 7] }], 10)).toEqual([
      { status: 'reviewed', range: [3, 7] },
    ])
  })

  it('adjacent same-status spans merge into one bar', () => {
    expect(
      lineStatuses(
        [
          { status: 'reviewed', range: [1, 3] },
          { status: 'reviewed', range: [4, 6] },
        ],
        10,
      ),
    ).toEqual([{ status: 'reviewed', range: [1, 6] }])
  })

  it('dismissed beats ambiguous where reviews that do not verify overlap', () => {
    expect(
      lineStatuses(
        [
          { status: 'ambiguous', range: [1, 6] },
          { status: 'dismissed', range: [4, 8] },
        ],
        10,
      ),
    ).toEqual([
      { status: 'ambiguous', range: [1, 3] },
      { status: 'dismissed', range: [4, 8] },
    ])
  })

  it('a dismissed file review does not paint over the reviews inside it that still verify', () => {
    expect(
      lineStatuses(
        [
          { status: 'dismissed', range: [1, 10] },
          { status: 'reviewed', range: [3, 5] },
          { status: 'ambiguous', range: [8, 9] },
        ],
        10,
      ),
    ).toEqual([
      { status: 'dismissed', range: [1, 2] },
      { status: 'reviewed', range: [3, 5] },
      { status: 'dismissed', range: [6, 10] },
    ])
  })

  it('a stale dismissed range never hides a fresh review of the code now on those lines', () => {
    expect(
      lineStatuses(
        [
          { status: 'reviewed', range: [4, 6] },
          { status: 'dismissed', range: [4, 6] },
        ],
        10,
      ),
    ).toEqual([{ status: 'reviewed', range: [4, 6] }])
  })

  it('untrusted ranges are clamped to the document and junk is dropped', () => {
    expect(
      lineStatuses(
        [
          { status: 'reviewed', range: [-4, 2] },
          { status: 'dismissed', range: [9, 99] },
          { status: 'ambiguous', range: [NaN, 3] },
          { status: 'ambiguous', range: [6, 5] },
        ],
        10,
      ),
    ).toEqual([
      { status: 'reviewed', range: [1, 2] },
      { status: 'dismissed', range: [9, 10] },
    ])
  })

  it('empty document or no spans -> no runs', () => {
    expect(lineStatuses([{ status: 'reviewed', range: [1, 1] }], 0)).toEqual([])
    expect(lineStatuses([], 10)).toEqual([])
  })
})

describe('mostUrgent', () => {
  it('dismissed, then ambiguous, then reviewed', () => {
    expect(mostUrgent('reviewed', 'dismissed')).toBe('dismissed')
    expect(mostUrgent('dismissed', 'ambiguous')).toBe('dismissed')
    expect(mostUrgent('ambiguous', 'reviewed')).toBe('ambiguous')
  })
})
