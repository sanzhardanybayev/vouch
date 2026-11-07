import { describe, it, expect } from 'vitest'
import { lineStatuses } from '../../src/core/bars'

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

  it('dismissed beats ambiguous beats reviewed where spans overlap', () => {
    expect(
      lineStatuses(
        [
          { status: 'reviewed', range: [1, 10] },
          { status: 'ambiguous', range: [3, 5] },
          { status: 'dismissed', range: [5, 6] },
        ],
        10,
      ),
    ).toEqual([
      { status: 'reviewed', range: [1, 2] },
      { status: 'ambiguous', range: [3, 4] },
      { status: 'dismissed', range: [5, 6] },
      { status: 'reviewed', range: [7, 10] },
    ])
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
