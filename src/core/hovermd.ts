export interface HoverEntry {
  authorName: string
  status: 'reviewed' | 'dismissed'
  createdAt: string
  comment?: string
  commit: string
  commitLink: string | null
  recordId: string
}

export function relTime(fromIso: string, toIso: string): string {
  const s = Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function statusLabel(status: 'reviewed' | 'dismissed'): string {
  return status === 'reviewed' ? '✓ reviewed' : '⚠ dismissed (changed since review)'
}

function cmd(command: string, recordId: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([recordId]))}`
}

// Escapes markdown-active characters in user-controlled text (authorName,
// comment) so it can never be interpreted as markdown — in particular so a
// `[label](command:...)` sequence can't become a clickable link. This is a
// single global-regex pass (not sequential per-character passes), so the
// order of characters in the class is irrelevant — none of the replacements
// can re-introduce a match for an earlier one.
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()<>#+\-!|])/g, '\\$1')
}

// The `commit` field of a ReviewRecord comes from shared, cross-user
// .vouch/*.jsonl records where only `id` is validated on parse — `commit` is
// otherwise untrusted attacker-controlled text. If it were interpolated into
// a markdown link destination unchecked, a value like
// `abc1234)[PWNED](command:vouch.reReview?%5B%22attacker-arg%22%5D` would
// forge a second clickable command link with an attacker-chosen argument
// (the enabledCommands allowlist only restricts the command *name*, not its
// arguments). Restricting to a plain hex string makes that structurally
// impossible: a valid git sha can never contain `)`, `[`, `]`, `(`, or `:`.
export function isValidSha(commit: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(commit)
}

export function rangeHoverMd(entries: HoverEntry[], nowIso: string): string {
  const parts: string[] = []
  for (const e of entries) {
    const sha = e.commit && isValidSha(e.commit) ? e.commit.slice(0, 7) : ''
    const shaMd = !sha ? '' : e.commitLink && e.commitLink.startsWith('https://')
      ? ` ([\`${sha}\`](${e.commitLink}))` : ` (\`${sha}\`)`
    parts.push(
      `**${statusLabel(e.status)}** — ${escapeMd(e.authorName)}, ${relTime(e.createdAt, nowIso)}${shaMd}`)
    if (e.comment) {
      const quoted = e.comment.split(/\r?\n/).map(line => `> ${escapeMd(line)}`).join('\n')
      parts.push(quoted)
    }
    parts.push(
      `[Open timeline](${cmd('vouch.openTimeline', e.recordId)}) · ` +
      `[Diff since review](${cmd('vouch.showDiff', e.recordId)}) · ` +
      `[Re-review](${cmd('vouch.reReview', e.recordId)})`)
  }
  return parts.join('\n\n')
}

export function callSiteMd(
  entries: { authorName: string; status: 'reviewed' | 'dismissed'; createdAt: string }[],
  nowIso: string,
): string {
  return entries.map(e =>
    `Vouch: ${statusLabel(e.status)} — ${escapeMd(e.authorName)}, ${relTime(e.createdAt, nowIso)}`,
  ).join('\n\n')
}
