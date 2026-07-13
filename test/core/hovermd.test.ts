import { describe, it, expect } from 'vitest'
import { rangeHoverMd, callSiteMd, relTime, escapeMd } from '../../src/core/hovermd'

const NOW = '2026-07-13T12:00:00Z'

describe('relTime', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(relTime('2026-07-13T11:59:30Z', NOW)).toBe('just now')
    expect(relTime('2026-07-13T11:55:00Z', NOW)).toBe('5m ago')
    expect(relTime('2026-07-13T09:00:00Z', NOW)).toBe('3h ago')
    expect(relTime('2026-07-11T12:00:00Z', NOW)).toBe('2d ago')
  })
})

describe('rangeHoverMd', () => {
  it('renders status, author, time, short sha, comment, command links', () => {
    const md = rangeHoverMd([{
      authorName: 'San', status: 'reviewed', createdAt: '2026-07-11T12:00:00Z',
      comment: 'checked errors', commit: 'abc1234def5678', commitLink: 'https://x/commit/abc1234def5678',
      recordId: 'r1',
    }], NOW)
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
    const md = rangeHoverMd([{ authorName: 'San', status: 'dismissed',
      createdAt: NOW, commit: '', commitLink: null, recordId: 'r1' }], NOW)
    expect(md).toContain('⚠ dismissed (changed since review)')
    expect(md).not.toContain('](null')
  })
})

describe('callSiteMd', () => {
  it('one line per author', () => {
    const md = callSiteMd([
      { authorName: 'San', status: 'reviewed', createdAt: '2026-07-11T12:00:00Z' },
      { authorName: 'Bob', status: 'dismissed', createdAt: NOW },
    ], NOW)
    expect(md).toContain('Vouch: ✓ reviewed — San, 2d ago')
    expect(md).toContain('Vouch: ⚠ dismissed (changed since review) — Bob')
  })

  it('escapes a malicious authorName so brackets cannot form a link', () => {
    const md = callSiteMd([
      { authorName: '[x](command:evil.cmd)', status: 'reviewed', createdAt: NOW },
    ], NOW)
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
    const md = rangeHoverMd([{
      authorName: 'San', status: 'reviewed', createdAt: NOW,
      comment: '[see details](command:workbench.action.terminal.sendSequence?evil)',
      commit: '', commitLink: null, recordId: 'r1',
    }], NOW)
    expect(md).not.toContain('](command:workbench')
    expect(md).not.toContain('](command:evil')
    expect(md).toContain(escapeMd('[see details](command:workbench.action.terminal.sendSequence?evil)'))
  })

  it('escapes brackets in a malicious authorName', () => {
    const md = rangeHoverMd([{
      authorName: '[click me](command:evil.cmd)', status: 'reviewed', createdAt: NOW,
      commit: '', commitLink: null, recordId: 'r1',
    }], NOW)
    expect(md).not.toContain('](command:evil')
    expect(md).toContain(escapeMd('[click me](command:evil.cmd)'))
  })

  it('blockquotes every line of a multi-line comment so it cannot escape the quote', () => {
    const md = rangeHoverMd([{
      authorName: 'San', status: 'reviewed', createdAt: NOW,
      comment: 'line one\nline two\r\nline three',
      commit: '', commitLink: null, recordId: 'r1',
    }], NOW)
    expect(md).toContain('> line one')
    expect(md).toContain('> line two')
    expect(md).toContain('> line three')
    // no unquoted line leaks out of the blockquote
    expect(md).not.toMatch(/\n(?!> )line (two|three)/)
  })
})
