import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveRecord } from '../core/anchor'
import { commitUrl } from '../core/giturl'
import { isValidSha } from '../core/hovermd'
import { timelineHtml, type TimelineInput, type TimelineEntry } from '../core/timelinehtml'
import type { VouchContext } from './context'
import { findRecord } from './diff'
import { remoteUrl } from './gitinfo'

export async function openTimeline(ctx: VouchContext, recordId: string): Promise<void> {
  const found = findRecord(ctx, recordId)
  if (!found) { void vscode.window.showWarningMessage('Vouch: record not found.'); return }
  const { rootDir, sourcePath } = found
  const root = ctx.roots.find(r => r.rootDir === rootDir)!
  const state = root.store.stateFor(sourcePath)!
  const remote = await remoteUrl(rootDir)

  let docText = ''
  try { docText = fs.readFileSync(path.join(rootDir, sourcePath), 'utf8') } catch { /* gone */ }

  const currentIds = new Set(state.current.map(r => r.id))
  const byUser = new Map<string, TimelineInput['users'][number]>()
  for (const [rootId, members] of state.chains) {
    const first = members[0]!
    const key = first.author.email
    if (!byUser.has(key)) byUser.set(key, { name: first.author.name, email: key, chains: [] })
    const entries: TimelineEntry[] = [...members].reverse().map(m => ({
      recordId: m.id,
      status: currentIds.has(m.id) && docText !== ''
        ? resolveRecord(m, docText).status : 'historical',
      createdAt: m.createdAt,
      commit: m.commit,
      // Commit values come from shared, cross-user .vouch/ records and are
      // otherwise untrusted (see core/hovermd.ts isValidSha) — never hand an
      // unvalidated commit to commitUrl. timelinehtml.ts independently
      // re-gates on isValidSha too, so this is defense in depth, matching
      // the pattern in vscode/hovers.ts and vscode/commands.ts.
      commitLink: m.commit && remote && isValidSha(m.commit) ? commitUrl(remote, m.commit) : null,
      comment: m.comment,
      kind: m.kind,
      symbol: m.symbol,
      range: m.range,
    }))
    byUser.get(key)!.chains.push({ entries, revoked: state.revokedChains.has(rootId) })
  }

  const panel = vscode.window.createWebviewPanel('vouchTimeline',
    `Vouch: ${sourcePath}`, vscode.ViewColumn.Beside, { enableScripts: true })
  const input: TimelineInput = {
    sourcePath, nowIso: new Date().toISOString(), users: [...byUser.values()] }
  panel.webview.html = timelineHtml(input, panel.webview.cspSource, randomUUID())
  panel.webview.onDidReceiveMessage((msg: { cmd: string; recordId: string }) => {
    if (msg.cmd === 'reReview') void vscode.commands.executeCommand('vouch.reReview', msg.recordId)
    if (msg.cmd === 'showDiff') void vscode.commands.executeCommand('vouch.showDiff', msg.recordId)
  })
}
