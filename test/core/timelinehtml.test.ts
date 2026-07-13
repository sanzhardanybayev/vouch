import { describe, it, expect } from 'vitest'
import { timelineHtml, escapeHtml } from '../../src/core/timelinehtml'

const NOW = '2026-07-13T12:00:00Z'

const INPUT = {
  sourcePath: 'src/a.ts',
  nowIso: '2026-07-13T12:00:00Z',
  users: [{
    name: 'San <script>', email: 's@x.com',
    chains: [{
      revoked: false,
      entries: [
        { recordId: 'r2', status: 'reviewed' as const, createdAt: '2026-07-12T12:00:00Z',
          commit: 'abc1234def', commitLink: 'https://x/commit/abc1234def',
          comment: 'v2 <b>bold</b>', kind: 'function', symbol: 'f' },
        { recordId: 'r1', status: 'historical' as const, createdAt: '2026-07-10T12:00:00Z',
          commit: '', commitLink: null, kind: 'selection', range: [1, 3] as [number, number] },
      ],
    }, { revoked: true, entries: [{ recordId: 'r0', status: 'historical' as const,
      createdAt: '2026-07-01T12:00:00Z', commit: '', commitLink: null, kind: 'selection' }] }],
  }],
}

describe('timelineHtml', () => {
  it('escapes user content and renders tabs, chains, revoked details', () => {
    const html = timelineHtml(INPUT, 'vscode-resource:', 'NONCE')
    expect(html).not.toContain('<script>')          // raw user input never passes through
    expect(html).toContain('San &lt;script&gt;')
    expect(html).toContain('v2 &lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain('abc1234')                // short sha
    expect(html).toContain('<details>')              // revoked chain
    expect(html).toContain('nonce="NONCE"')
    expect(html).toContain("default-src 'none'")
  })
  it('escapeHtml covers the five specials', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('gates commit sha/link through isValidSha — a malicious commit renders no sha and no link', () => {
    const html = timelineHtml({
      sourcePath: 'src/a.ts',
      nowIso: NOW,
      users: [{
        name: 'San', email: 's@x.com',
        chains: [{
          revoked: false,
          entries: [{
            recordId: 'r9', status: 'reviewed' as const, createdAt: NOW,
            // Structurally malicious commit + a commitLink that forges a
            // second command link — mirrors the Task 13 hovermd attack.
            commit: 'abc1234)[PWNED](command:vouch.reReview?x',
            commitLink: 'command:vouch.reReview?%5B%22attacker-arg%22%5D',
            kind: 'selection',
          }],
        }],
      }],
    }, 'vscode-resource:', 'NONCE')
    expect(html).not.toContain('PWNED')
    expect(html).not.toContain('attacker-arg')
    expect(html).not.toContain('command:vouch.reReview?%5B%22attacker-arg%22%5D')
    expect(html).not.toContain('abc1234)')
  })

  it('restricts commitLink to https:// — a javascript: URI renders no link but still shows the sha', () => {
    const html = timelineHtml({
      sourcePath: 'src/a.ts',
      nowIso: NOW,
      users: [{
        name: 'San', email: 's@x.com',
        chains: [{
          revoked: false,
          entries: [{
            recordId: 'r7', status: 'reviewed' as const, createdAt: NOW,
            commit: 'abc1234def', commitLink: 'javascript:alert(1)',
            kind: 'selection',
          }],
        }],
      }],
    }, 'vscode-resource:', 'NONCE')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<a ')
    expect(html).toContain('<code>abc1234</code>')
  })

  it('renders no sha/link when commit is empty even if commitLink is (wrongly) set', () => {
    const html = timelineHtml({
      sourcePath: 'src/a.ts',
      nowIso: NOW,
      users: [{
        name: 'San', email: 's@x.com',
        chains: [{
          revoked: false,
          entries: [{
            recordId: 'r8', status: 'reviewed' as const, createdAt: NOW,
            commit: '', commitLink: 'https://evil.example/commit/x',
            kind: 'selection',
          }],
        }],
      }],
    }, 'vscode-resource:', 'NONCE')
    expect(html).not.toContain('evil.example')
  })
})
