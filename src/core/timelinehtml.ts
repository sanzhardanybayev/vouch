import { isValidSha, relTime } from './hovermd'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export interface TimelineEntry {
  recordId: string
  status: 'reviewed' | 'dismissed' | 'historical'
  createdAt: string
  commit: string
  commitLink: string | null
  comment?: string
  kind: string
  symbol?: string
  range?: [number, number]
}
export interface TimelineInput {
  sourcePath: string
  nowIso: string
  users: { name: string; email: string
    chains: { entries: TimelineEntry[]; revoked: boolean }[] }[]
}

const GLYPH = { reviewed: '✓', dismissed: '⚠', historical: '·' } as const

function entryHtml(e: TimelineEntry, nowIso: string): string {
  // The commit (and thus any derived sha/link) comes from shared, untrusted
  // .vouch/ records — same threat model as core/hovermd.ts's rangeHoverMd.
  // Gate on isValidSha here (the pure builder) so a structurally malicious
  // commit can never produce a sha or a link, regardless of what the caller
  // passes as commitLink.
  const sha = e.commit && isValidSha(e.commit) ? e.commit.slice(0, 7) : ''
  const shaHtml = !sha ? '' : e.commitLink
    ? ` <a href="${escapeHtml(e.commitLink)}"><code>${escapeHtml(sha)}</code></a>`
    : ` <code>${escapeHtml(sha)}</code>`
  const what = e.symbol ? `${e.kind} ${e.symbol}`
    : e.range ? `${e.kind} L${e.range[0]}–${e.range[1]}` : e.kind
  const comment = e.comment ? `<blockquote>${escapeHtml(e.comment)}</blockquote>` : ''
  const actions = e.status === 'dismissed'
    ? ` <button data-cmd="reReview" data-id="${escapeHtml(e.recordId)}">Re-review</button>` : ''
  const diffBtn = e.status !== 'historical'
    ? ` <button data-cmd="showDiff" data-id="${escapeHtml(e.recordId)}">Diff</button>` : ''
  return `<li class="${e.status}"><span class="glyph">${GLYPH[e.status]}</span> ` +
    `<strong>${e.status}</strong> — ${escapeHtml(what)}, ${relTime(e.createdAt, nowIso)}` +
    `${shaHtml}${actions}${diffBtn}${comment}</li>`
}

export function timelineHtml(input: TimelineInput, cspSource: string, nonce: string): string {
  const tabs = input.users.map((u, i) =>
    `<button class="tab" data-tab="${i}">${escapeHtml(u.name)}</button>`).join('')
  const panes = input.users.map((u, i) => {
    const chains = u.chains.map(c => {
      const list = `<ul>${c.entries.map(e => entryHtml(e, input.nowIso)).join('')}</ul>`
      return c.revoked ? `<details><summary>revoked chain</summary>${list}</details>` : list
    }).join('')
    return `<section class="pane" data-pane="${i}">${chains}</section>`
  }).join('')
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'">
<style>
  body { font-family: var(--vscode-font-family); }
  .tab { margin-right: .5em; } .pane { display: none; } .pane.active { display: block; }
  li.reviewed .glyph { color: var(--vscode-charts-green); }
  li.dismissed .glyph { color: var(--vscode-charts-yellow); }
  blockquote { opacity: .8; margin: .2em 0 .6em 1.5em; }
</style></head><body>
<h3>${escapeHtml(input.sourcePath)}</h3>
<nav>${tabs}</nav>${panes}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  const activate = i => {
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === String(i)))
  }
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => activate(t.dataset.tab)))
  document.querySelectorAll('button[data-cmd]').forEach(b =>
    b.addEventListener('click', () => vscode.postMessage({ cmd: b.dataset.cmd, recordId: b.dataset.id })))
  activate(0)
</script></body></html>`
}
