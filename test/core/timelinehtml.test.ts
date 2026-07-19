import { describe, it, expect } from 'vitest'
import { timelineHtml, escapeHtml } from '../../src/core/timelinehtml'

const NOW = '2026-07-13T12:00:00Z'

const INPUT = {
  sourcePath: 'src/a.ts',
  nowIso: '2026-07-13T12:00:00Z',
  users: [
    {
      name: 'San <script>',
      email: 's@x.com',
      chains: [
        {
          revoked: false,
          entries: [
            {
              recordId: 'r2',
              status: 'reviewed' as const,
              createdAt: '2026-07-12T12:00:00Z',
              commit: 'abc1234def',
              commitLink: 'https://x/commit/abc1234def',
              comment: 'v2 <b>bold</b>',
              kind: 'function',
              symbol: 'f',
            },
            {
              recordId: 'r1',
              status: 'historical' as const,
              createdAt: '2026-07-10T12:00:00Z',
              commit: '',
              commitLink: null,
              kind: 'selection',
              range: [1, 3] as [number, number],
            },
          ],
        },
        {
          revoked: true,
          entries: [
            {
              recordId: 'r0',
              status: 'historical' as const,
              createdAt: '2026-07-01T12:00:00Z',
              commit: '',
              commitLink: null,
              kind: 'selection',
            },
          ],
        },
      ],
    },
  ],
}

describe('timelineHtml', () => {
  it('escapes user content and renders tabs, chains, revoked details', () => {
    const html = timelineHtml(INPUT, 'vscode-resource:', 'NONCE')
    expect(html).not.toContain('<script>') // raw user input never passes through
    expect(html).toContain('San &lt;script&gt;')
    expect(html).toContain('v2 &lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain('abc1234') // short sha
    expect(html).toContain('<details>') // revoked chain
    expect(html).toContain('nonce="NONCE"')
    expect(html).toContain("default-src 'none'")
  })
  it('escapeHtml covers the five specials', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('renders a Go to button for ranged and file-kind entries, not for rangeless ones', () => {
    const html = timelineHtml(
      {
        sourcePath: 'src/a.ts',
        nowIso: NOW,
        users: [
          {
            name: 'San',
            email: 's@x.com',
            chains: [
              {
                revoked: false,
                entries: [
                  {
                    recordId: 'r1',
                    status: 'reviewed' as const,
                    createdAt: NOW,
                    commit: '',
                    commitLink: null,
                    kind: 'selection',
                    range: [1, 3] as [number, number],
                  },
                  {
                    recordId: 'r2',
                    status: 'reviewed' as const,
                    createdAt: NOW,
                    commit: '',
                    commitLink: null,
                    kind: 'file',
                  },
                  {
                    recordId: 'r3',
                    status: 'historical' as const,
                    createdAt: NOW,
                    commit: '',
                    commitLink: null,
                    kind: 'selection',
                  },
                ],
              },
            ],
          },
        ],
      },
      'vscode-resource:',
      'NONCE',
    )
    expect(html).toContain('<button data-cmd="reveal" data-id="r1">Go to</button>')
    expect(html).toContain('<button data-cmd="reveal" data-id="r2">Go to</button>')
    expect(html).not.toContain('data-cmd="reveal" data-id="r3"')
  })

  it('renders the Diff button for historical entries too', () => {
    const html = timelineHtml(INPUT, 'vscode-resource:', 'NONCE')
    expect(html).toContain('<button data-cmd="showDiff" data-id="r1">Diff</button>')
    expect(html).toContain('<button data-cmd="showDiff" data-id="r0">Diff</button>')
  })

  it('reveal wiring rides the existing generic button handler - no reveal code in the script', () => {
    const html = timelineHtml(INPUT, 'vscode-resource:', 'NONCE')
    const script = html.slice(html.indexOf('<script'))
    expect(script).toContain('button[data-cmd]')
    expect(script).not.toContain('reveal')
  })

  it('gates commit sha/link through isValidSha — a malicious commit renders no sha and no link', () => {
    const html = timelineHtml(
      {
        sourcePath: 'src/a.ts',
        nowIso: NOW,
        users: [
          {
            name: 'San',
            email: 's@x.com',
            chains: [
              {
                revoked: false,
                entries: [
                  {
                    recordId: 'r9',
                    status: 'reviewed' as const,
                    createdAt: NOW,
                    // Structurally malicious commit + a commitLink that forges a
                    // second command link — mirrors the Task 13 hovermd attack.
                    commit: 'abc1234)[PWNED](command:vouch.reReview?x',
                    commitLink: 'command:vouch.reReview?%5B%22attacker-arg%22%5D',
                    kind: 'selection',
                  },
                ],
              },
            ],
          },
        ],
      },
      'vscode-resource:',
      'NONCE',
    )
    expect(html).not.toContain('PWNED')
    expect(html).not.toContain('attacker-arg')
    expect(html).not.toContain('command:vouch.reReview?%5B%22attacker-arg%22%5D')
    expect(html).not.toContain('abc1234)')
  })

  it('restricts commitLink to https:// — a javascript: URI renders no link but still shows the sha', () => {
    const html = timelineHtml(
      {
        sourcePath: 'src/a.ts',
        nowIso: NOW,
        users: [
          {
            name: 'San',
            email: 's@x.com',
            chains: [
              {
                revoked: false,
                entries: [
                  {
                    recordId: 'r7',
                    status: 'reviewed' as const,
                    createdAt: NOW,
                    commit: 'abc1234def',
                    commitLink: 'javascript:alert(1)',
                    kind: 'selection',
                  },
                ],
              },
            ],
          },
        ],
      },
      'vscode-resource:',
      'NONCE',
    )
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<a ')
    expect(html).toContain('<code>abc1234</code>')
  })

  it('renders no sha/link when commit is empty even if commitLink is (wrongly) set', () => {
    const html = timelineHtml(
      {
        sourcePath: 'src/a.ts',
        nowIso: NOW,
        users: [
          {
            name: 'San',
            email: 's@x.com',
            chains: [
              {
                revoked: false,
                entries: [
                  {
                    recordId: 'r8',
                    status: 'reviewed' as const,
                    createdAt: NOW,
                    commit: '',
                    commitLink: 'https://evil.example/commit/x',
                    kind: 'selection',
                  },
                ],
              },
            ],
          },
        ],
      },
      'vscode-resource:',
      'NONCE',
    )
    expect(html).not.toContain('evil.example')
  })
})

describe('timelineHtml — ambiguous entries', () => {
  const mk = (status: 'reviewed' | 'dismissed' | 'ambiguous' | 'historical') => ({
    sourcePath: 'src/a.ts',
    nowIso: NOW,
    users: [
      {
        name: 'San',
        email: 's@x.com',
        chains: [
          {
            revoked: false,
            entries: [
              {
                recordId: 'r1',
                status: status as never,
                createdAt: NOW,
                commit: '',
                commitLink: null,
                kind: 'selection',
                range: [4, 4] as [number, number],
              },
            ],
          },
        ],
      },
    ],
  })

  it('renders the ? glyph, an ambiguous class, and a Resolve button', () => {
    const html = timelineHtml(mk('ambiguous'), 'vscode-resource:', 'NONCE')
    expect(html).toContain('class="ambiguous"')
    expect(html).toContain('<span class="glyph">?</span>')
    expect(html).toContain('<button data-cmd="resolveAmbiguous" data-id="r1">Resolve</button>')
    expect(html).not.toContain('undefined')
  })

  it('offers Re-review for ambiguous entries too, and Resolve only for ambiguous', () => {
    const amb = timelineHtml(mk('ambiguous'), 'vscode-resource:', 'NONCE')
    expect(amb).toContain('data-cmd="reReview"')
    const rev = timelineHtml(mk('reviewed'), 'vscode-resource:', 'NONCE')
    expect(rev).not.toContain('resolveAmbiguous')
    const dis = timelineHtml(mk('dismissed'), 'vscode-resource:', 'NONCE')
    expect(dis).toContain('data-cmd="reReview"')
    expect(dis).not.toContain('resolveAmbiguous')
  })
})
