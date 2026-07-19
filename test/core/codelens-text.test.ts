import { describe, it, expect } from 'vitest'
import { codeLensTitle } from '../../src/core/codelens-text'

const NOW = '2026-07-13T12:00:00Z'

describe('codeLensTitle', () => {
  it('empty → empty string', () => {
    expect(codeLensTitle([], NOW)).toBe('')
  })
  it('single reviewed', () => {
    expect(
      codeLensTitle(
        [{ authorName: 'San', status: 'reviewed', createdAt: '2026-06-29T12:00:00Z' }],
        NOW,
      ),
    ).toBe('✓ Reviewed by San, 14d ago')
  })
  it('dismissed wins over reviewed and prompts re-review', () => {
    expect(
      codeLensTitle(
        [
          { authorName: 'San', status: 'reviewed', createdAt: NOW },
          { authorName: 'Bob', status: 'dismissed', createdAt: NOW },
        ],
        NOW,
      ),
    ).toBe('⚠ Dismissed (changed since review) — re-review')
  })
  it('multiple reviewed shows most-recent author + count', () => {
    expect(
      codeLensTitle(
        [
          { authorName: 'San', status: 'reviewed', createdAt: '2026-06-01T12:00:00Z' },
          { authorName: 'Bob', status: 'reviewed', createdAt: '2026-07-12T12:00:00Z' },
        ],
        NOW,
      ),
    ).toBe('✓ Reviewed by Bob +1 more, 1d ago')
  })

  it('ambiguous prompts resolve when nothing is dismissed', () => {
    expect(
      codeLensTitle(
        [
          { authorName: 'San', status: 'reviewed', createdAt: NOW },
          { authorName: 'San', status: 'ambiguous', createdAt: NOW },
        ],
        NOW,
      ),
    ).toBe('? Ambiguous (location cannot be verified) - resolve')
  })

  it('dismissed still wins over ambiguous', () => {
    expect(
      codeLensTitle(
        [
          { authorName: 'San', status: 'ambiguous', createdAt: NOW },
          { authorName: 'Bob', status: 'dismissed', createdAt: NOW },
        ],
        NOW,
      ),
    ).toBe('⚠ Dismissed (changed since review) — re-review')
  })
})
