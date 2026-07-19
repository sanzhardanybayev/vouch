import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveRecord } from '../core/anchor'
import { isKnownKind } from '../core/records'
import { commitUrl } from '../core/giturl'
import { isValidSha } from '../core/hovermd'
import { timelineHtml, type TimelineInput, type TimelineEntry } from '../core/timelinehtml'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { findRecord } from './diff'
import { remoteUrl } from './gitinfo'

async function buildInput(
  ctx: VouchContext,
  pipeline: StatusPipeline,
  rootDir: string,
  sourcePath: string,
): Promise<TimelineInput | null> {
  const root = ctx.roots.find((r) => r.rootDir === rootDir)
  const state = root?.store.stateFor(sourcePath)
  if (!root || !state) return null
  const remote = await remoteUrl(rootDir)

  // Buffer truth: when the file is open, statuses come from the same
  // pipeline that drives the gutter/lens/hover, so the timeline can never
  // show a green check the gutter has already dismissed. Disk text is the
  // fallback for files that are not open anywhere.
  const abs = path.join(rootDir, sourcePath)
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && d.uri.fsPath === abs,
  )
  const pipelineEntries = openDoc ? (await pipeline.statusFor(openDoc)).entries : null
  let docText = ''
  if (!openDoc) {
    try {
      docText = fs.readFileSync(abs, 'utf8')
    } catch {
      /* gone */
    }
  }
  const statusOf = (id: string): TimelineEntry['status'] => {
    if (pipelineEntries) {
      return pipelineEntries.find((e) => e.record.id === id)?.res.status ?? 'historical'
    }
    const rec = state.current.find((r) => r.id === id)
    // Unknown future kinds resolve 'dismissed', which would falsely read as
    // "changed since review"; show them as historical like every other surface.
    return rec && isKnownKind(rec) && docText !== ''
      ? resolveRecord(rec, docText).status
      : 'historical'
  }

  const currentIds = new Set(state.current.map((r) => r.id))
  const byUser = new Map<string, TimelineInput['users'][number]>()
  for (const [rootId, members] of state.chains) {
    const first = members[0]!
    const key = first.author.email
    if (!byUser.has(key)) byUser.set(key, { name: first.author.name, email: key, chains: [] })
    const entries: TimelineEntry[] = [...members].reverse().map((m) => ({
      recordId: m.id,
      status: currentIds.has(m.id) ? statusOf(m.id) : 'historical',
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
  return { sourcePath, nowIso: new Date().toISOString(), users: [...byUser.values()] }
}

export async function openTimeline(
  ctx: VouchContext,
  pipeline: StatusPipeline,
  recordId: string,
): Promise<void> {
  const found = findRecord(ctx, recordId)
  if (!found) {
    void vscode.window.showWarningMessage('Vouch: record not found.')
    return
  }
  const { rootDir, sourcePath } = found

  const panel = vscode.window.createWebviewPanel(
    'vouchTimeline',
    `Vouch: ${sourcePath}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  )

  // Coalesce, never drop: buildInput reads store state synchronously then
  // awaits (git remoteUrl, pipeline). An event arriving mid-render must cause
  // ONE more pass afterward so the panel reflects the latest store, not
  // whatever was current when the in-flight pass started.
  let disposed = false
  let rendering = false
  let renderPending = false
  const render = async (): Promise<void> => {
    if (rendering) {
      renderPending = true
      return
    }
    rendering = true
    try {
      do {
        renderPending = false
        const input = await buildInput(ctx, pipeline, rootDir, sourcePath)
        // The panel can be closed while we await; touching its webview then
        // throws 'Webview is disposed'.
        if (disposed) return
        if (input) panel.webview.html = timelineHtml(input, panel.webview.cspSource, randomUUID())
      } while (renderPending && !disposed)
    } finally {
      rendering = false
    }
  }

  // Stay truthful while open: store changes (attest/revoke/pull) come via
  // ctx.onDidChange; live-buffer edits come via pipeline.onDidUpdate for
  // this file's uri (already debounced by the pipeline).
  const abs = path.join(rootDir, sourcePath)
  const listeners = [
    ctx.onDidChange(() => {
      void render()
    }),
    pipeline.onDidUpdate((uri) => {
      if (uri.scheme === 'file' && uri.fsPath === abs) void render()
    }),
  ]
  panel.onDidDispose(() => {
    disposed = true
    for (const l of listeners) l.dispose()
  })

  panel.webview.onDidReceiveMessage((msg: { cmd: string; recordId: string }) => {
    if (msg.cmd === 'reReview') void vscode.commands.executeCommand('vouch.reReview', msg.recordId)
    if (msg.cmd === 'showDiff') void vscode.commands.executeCommand('vouch.showDiff', msg.recordId)
    if (msg.cmd === 'resolveAmbiguous') {
      void vscode.commands.executeCommand('vouch.resolveAmbiguous', msg.recordId)
    }
    if (msg.cmd === 'reveal') void revealRecord(ctx, msg.recordId)
  })

  await render()
}

// recordId arrives from the webview and is untrusted - it is only ever used
// as a lookup key into our own store (findRecord) and never interpolated
// into anything.
async function revealRecord(ctx: VouchContext, recordId: string): Promise<void> {
  const found = findRecord(ctx, recordId)
  if (!found) {
    void vscode.window.showWarningMessage('Vouch: record not found.')
    return
  }
  const { record, rootDir, sourcePath } = found
  let doc: vscode.TextDocument
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(rootDir, sourcePath)))
  } catch {
    void vscode.window.showWarningMessage(`Vouch: ${sourcePath} not found.`)
    return
  }
  const range: [number, number] =
    record.kind === 'file' ? [1, 1] : resolveRecord(record, doc.getText()).effectiveRange
  // Record ranges are 1-based inclusive lines; resolveRecord clamps them to
  // >= 1 (untrusted record data - Position throws on negative lines) and
  // validateRange clamps the line-end sentinel column and any past-the-end
  // line to the document.
  const target = doc.validateRange(
    new vscode.Range(range[0] - 1, 0, range[1] - 1, Number.MAX_SAFE_INTEGER),
  )
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(target.start, target.end)
  editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}
