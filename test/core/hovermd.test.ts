import { describe, it, expect } from 'vitest'
import { rangeHoverMd, callSiteMd, relTime, escapeMd, isValidSha } from '../../src/core/hovermd'

const NOW = '2026-07-13T12:00:00Z'

describe('relTime', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(relTime('2026-07-13T11:59:30Z', NOW)).toBe('just now')
    expect(relTime('2026-07-13T11:55:00Z', NOW)).toBe('5m ago')
    expect(relTime('2026-07-13T09:00:00Z', NOW)).toBe('3h ago')
    expect(relTime('2026-07-11T12:00:00Z', NOW)).toBe('2d ago')
  })

  it('unparseable createdAt renders "unknown time", never NaN', () => {
    expect(relTime('garbage', NOW)).toBe('unknown time')
    expect(relTime('', NOW)).toBe('unknown time')
  })
})

describe('rangeHoverMd', () => {
  it('renders status, author, time, short sha, comment, command links', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: '2026-07-11T12:00:00Z',
          comment: 'checked errors',
          commit: 'abc1234def5678',
          commitLink: 'https://x/commit/abc1234def5678',
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).toContain('✓ reviewed')
    expect(md).toContain('San')
    expect(md).toContain('2d ago')
    expect(md).toContain('[`abc1234`](https://x/commit/abc1234def5678)')
    expect(md).toContain('> checked errors')
    expect(md).toContain(`command:vouch.showDiff?${encodeURIComponent(JSON.stringify(['r1']))}`)
    expect(md).toContain('command:vouch.reReview?')
    expect(md).toContain('command:vouch.openTimeline?')
  })
  it('dismissed uses warning glyph and label', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'dismissed',
          createdAt: NOW,
          commit: '',
          commitLink: null,
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).toContain('⚠ dismissed (changed since review)')
    expect(md).not.toContain('](null')
  })

  it('ambiguous gets its own label and a Resolve command link', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'ambiguous',
          createdAt: NOW,
          commit: '',
          commitLink: null,
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).toContain('? ambiguous (location cannot be verified)')
    expect(md).toContain(
      `command:vouch.resolveAmbiguous?${encodeURIComponent(JSON.stringify(['r1']))}`,
    )
  })

  it('reviewed and dismissed entries never carry a Resolve link', () => {
    for (const status of ['reviewed', 'dismissed'] as const) {
      const md = rangeHoverMd(
        [
          {
            authorName: 'San',
            status,
            createdAt: NOW,
            commit: '',
            commitLink: null,
            recordId: 'r1',
          },
        ],
        NOW,
      )
      expect(md).not.toContain('vouch.resolveAmbiguous')
    }
  })
})

describe('rangeHoverMd - supersedes count', () => {
  const base = {
    authorName: 'San',
    status: 'reviewed' as const,
    createdAt: NOW,
    commit: '',
    commitLink: null,
    recordId: 'r1',
  }

  it('renders nothing when supersedesCount is absent or 0', () => {
    expect(rangeHoverMd([base], NOW)).not.toContain('supersedes')
    expect(rangeHoverMd([{ ...base, supersedesCount: 0 }], NOW)).not.toContain('supersedes')
  })

  it('renders singular for 1', () => {
    const md = rangeHoverMd([{ ...base, supersedesCount: 1 }], NOW)
    expect(md).toContain('supersedes 1 earlier review')
    expect(md).not.toContain('supersedes 1 earlier reviews')
  })

  it('renders plural for 3', () => {
    expect(rangeHoverMd([{ ...base, supersedesCount: 3 }], NOW)).toContain(
      'supersedes 3 earlier reviews',
    )
  })

  it('is plain text placed before the action links, never a link itself', () => {
    const md = rangeHoverMd([{ ...base, supersedesCount: 2 }], NOW)
    expect(md.indexOf('supersedes 2 earlier reviews')).toBeLessThan(md.indexOf('[Open timeline]'))
    expect(md).not.toContain('[supersedes')
    expect(md).not.toContain('supersedes 2 earlier reviews](')
  })
})

describe('callSiteMd', () => {
  it('one line per author', () => {
    const md = callSiteMd(
      [
        { authorName: 'San', status: 'reviewed', createdAt: '2026-07-11T12:00:00Z' },
        { authorName: 'Bob', status: 'dismissed', createdAt: NOW },
      ],
      NOW,
    )
    expect(md).toContain('Vouch: ✓ reviewed — San, 2d ago')
    expect(md).toContain('Vouch: ⚠ dismissed (changed since review) — Bob')
  })

  it('escapes a malicious authorName so brackets cannot form a link', () => {
    const md = callSiteMd(
      [{ authorName: '[x](command:evil.cmd)', status: 'reviewed', createdAt: NOW }],
      NOW,
    )
    expect(md).not.toContain('[x](command:evil.cmd)')
    expect(md).toContain(escapeMd('[x](command:evil.cmd)'))
  })
})

describe('escapeMd', () => {
  it('escapes markdown-active characters', () => {
    expect(escapeMd('[a](b)')).toBe('\\[a\\]\\(b\\)')
    expect(escapeMd('back`tick`')).toBe('back\\`tick\\`')
    expect(escapeMd('a\\b')).toBe('a\\\\b')
    expect(escapeMd('<tag>')).toBe('\\<tag\\>')
    expect(escapeMd('a|b')).toBe('a\\|b')
    expect(escapeMd('plain text 123')).toBe('plain text 123')
  })
})

describe('rangeHoverMd — injection safety', () => {
  it('a malicious comment with a command link cannot survive as a clickable link', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          comment: '[see details](command:workbench.action.terminal.sendSequence?evil)',
          commit: '',
          commitLink: null,
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).not.toContain('](command:workbench')
    expect(md).not.toContain('](command:evil')
    expect(md).toContain(
      escapeMd('[see details](command:workbench.action.terminal.sendSequence?evil)'),
    )
  })

  it('escapes brackets in a malicious authorName', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: '[click me](command:evil.cmd)',
          status: 'reviewed',
          createdAt: NOW,
          commit: '',
          commitLink: null,
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).not.toContain('](command:evil')
    expect(md).toContain(escapeMd('[click me](command:evil.cmd)'))
  })

  it('blockquotes every line of a multi-line comment so it cannot escape the quote', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          comment: 'line one\nline two\r\nline three',
          commit: '',
          commitLink: null,
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).toContain('> line one')
    expect(md).toContain('> line two')
    expect(md).toContain('> line three')
    // no unquoted line leaks out of the blockquote
    expect(md).not.toMatch(/\n(?!> )line (two|three)/)
  })

  it('a malicious commit forging a second command link is rejected outright (no sha, no link)', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          commit: 'abc1234)[PWNED](command:vouch.reReview?x',
          commitLink: 'command:vouch.reReview?%5B%22attacker-arg%22%5D',
          recordId: 'r1',
        },
      ],
      NOW,
    )
    // Only the three legitimate action links should produce `](command:` —
    // a forged commit must not add a fourth.
    const commandLinkCount = (md.match(/\]\(command:/g) ?? []).length
    expect(commandLinkCount).toBe(3)
    expect(md).not.toContain('PWNED')
    expect(md).not.toContain('attacker-arg')
  })
})

describe('rangeHoverMd — commit sha validation', () => {
  it('renders the linked short sha for a valid 40-hex commit', () => {
    const commit = 'a'.repeat(40)
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          commit,
          commitLink: `https://x/commit/${commit}`,
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).toContain(`[\`${commit.slice(0, 7)}\`](https://x/commit/${commit})`)
  })

  it('renders the linked short sha for a valid 7-hex commit', () => {
    const md = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          commit: 'abc1234',
          commitLink: 'https://x/commit/abc1234',
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(md).toContain('[`abc1234`](https://x/commit/abc1234)')
  })

  it('does not render a non-https commitLink as a clickable sha link (command:/javascript:)', () => {
    const commandMd = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          commit: 'abc1234def5678',
          commitLink: 'command:vouch.reReview?x',
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(commandMd).not.toContain('](command:vouch.reReview?x')
    expect(commandMd).toContain('(`abc1234`)')

    const jsMd = rangeHoverMd(
      [
        {
          authorName: 'San',
          status: 'reviewed',
          createdAt: NOW,
          commit: 'abc1234def5678',
          commitLink: 'javascript:alert(1)',
          recordId: 'r1',
        },
      ],
      NOW,
    )
    expect(jsMd).not.toContain('](javascript:')
    expect(jsMd).toContain('(`abc1234`)')
  })
})

describe('isValidSha', () => {
  it('accepts valid hex lengths (4–40)', () => {
    expect(isValidSha('abcd')).toBe(true)
    expect(isValidSha('abc1234')).toBe(true)
    expect(isValidSha('abc1234def5678')).toBe(true)
    expect(isValidSha('a'.repeat(40))).toBe(true)
    expect(isValidSha('A1B2C3D4')).toBe(true)
  })

  it('rejects non-hex, too-short, too-long, or structurally malicious values', () => {
    expect(isValidSha('')).toBe(false)
    expect(isValidSha('abc')).toBe(false) // too short
    expect(isValidSha('a'.repeat(41))).toBe(false) // too long
    expect(isValidSha('xyz1234')).toBe(false) // non-hex chars
    expect(isValidSha('abc1234)[PWNED](command:vouch.reReview?x')).toBe(false)
  })
})
