import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildRecord, buildReattachLines, overlaps, supersedeCandidates } from '../core/attest'
import { prefillComment, summarizeCandidates } from '../core/consolidate'
import { enclosingSymbol, resolveRecord, resolveSymbolPath } from '../core/anchor'
import { authorSlug } from '../core/paths'
import { appendLine, initVouch } from '../core/writer'
import type { Author, RecordKind, ReviewRecord, Tombstone } from '../core/types'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { documentSymbols } from './symbols'
import { headSha, identity, isDirty, remoteUrl } from './gitinfo'
import { showDiff, findRecord } from './diff'
import { commitUrl } from '../core/giturl'
import { isValidSha } from '../core/hovermd'
import { openTimeline } from './panel'

async function resolveAuthor(
  extCtx: vscode.ExtensionContext, cwd: string,
): Promise<Author | null> {
  const fromGit = await identity(cwd)
  if (fromGit) return fromGit
  const saved = extCtx.globalState.get<Author>('vouch.identity')
  if (saved) return saved
  const name = await vscode.window.showInputBox({ prompt: 'Vouch: your name (no git identity found)' })
  if (!name) return null
  const email = await vscode.window.showInputBox({ prompt: 'Vouch: your email' })
  if (!email) return null
  const author = { name, email }
  await extCtx.globalState.update('vouch.identity', author)
  return author
}

/** Shared state each command needs about the active editor. */
async function editorState(ctx: VouchContext): Promise<{
  editor: vscode.TextEditor; rootDir: string; sourcePath: string
} | null> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Vouch: no active file editor.')
    return null
  }
  const root = ctx.rootFor(editor.document.uri)
  const sourcePath = ctx.sourcePathOf(editor.document.uri)
  if (!root || !sourcePath) {
    void vscode.window.showInformationMessage('Vouch: file is outside the workspace.')
    return null
  }
  return { editor, rootDir: root.rootDir, sourcePath }
}

export function currentResolved(
  ctx: VouchContext, rootDir: string, sourcePath: string, docText: string,
): { record: ReviewRecord; res: ReturnType<typeof resolveRecord> }[] {
  const root = ctx.roots.find(r => r.rootDir === rootDir)
  const state = root?.store.stateFor(sourcePath)
  if (!state) return []
  return state.current.map(record => ({ record, res: resolveRecord(record, docText) }))
}

async function attest(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void,
  pipeline: StatusPipeline, kind: RecordKind,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const doc = editor.document

  let range: [number, number] | undefined
  let symbol: string | undefined
  if (kind === 'selection') {
    const sel = editor.selection
    range = [sel.start.line + 1, sel.end.line + 1]
  } else if (kind === 'function' || kind === 'class') {
    const symbols = await documentSymbols(doc.uri)
    const found = enclosingSymbol(symbols, editor.selection.active.line + 1, kind)
    if (!found) {
      void vscode.window.showInformationMessage(
        `Vouch: no enclosing ${kind} symbol — select lines and use "Review selected lines".`)
      return
    }
    range = found.range
    symbol = found.path
  }

  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return

  const docText = doc.getText()
  const existing = currentResolved(ctx, rootDir, sourcePath, docText)
  const candidates = supersedeCandidates({ author, kind, symbol, range, existingCurrent: existing })
  const summary = summarizeCandidates(candidates)

  let prefill = ''
  if (candidates.length > 0 && (summary.withComments > 0 || summary.dismissed > 0)) {
    // Modal text is counts only: candidate symbols/comments are untrusted
    // cross-user data and must never be interpolated into message/detail.
    const message = `Vouching this ${kind} supersedes ${summary.total} of your reviews.`
    const detailParts: string[] = []
    if (summary.withComments > 0) detailParts.push(`${summary.withComments} of them carry comments.`)
    if (summary.dismissed > 0) {
      detailParts.push(`${summary.dismissed} are dismissed - code changed since you reviewed them.`)
    }
    const detail = detailParts.join('\n')
    // Cycle through ALL dismissed candidates on repeated "View diff" clicks;
    // stopping at the first would let the rest be superseded sight unseen.
    const dismissedCandidates = candidates.filter(c => c.res.status === 'dismissed')
    let diffCursor = 0
    for (;;) {
      const items: string[] = summary.withComments > 0
        ? ['Copy comments & continue', 'Continue without copying']
        : ['Continue']
      if (summary.dismissed > 0) items.push('View diff')
      const choice = await vscode.window.showWarningMessage(
        message, { modal: true, detail }, ...items)
      if (choice === undefined) return // Esc aborts the vouch
      if (choice === 'View diff') {
        const dismissed = dismissedCandidates[diffCursor % dismissedCandidates.length]
        if (dismissed) {
          diffCursor++
          await showDiff(ctx, pipeline, dismissed.record.id)
        }
        continue
      }
      if (choice === 'Copy comments & continue') prefill = prefillComment(candidates)
      break
    }
  }

  const comment = await vscode.window.showInputBox({
    prompt: 'Vouch: optional comment (Enter to skip)', value: prefill })
  if (comment === undefined) return // Esc cancels

  const commit = (await headSha(rootDir)) ?? ''
  const dirty = commit ? await isDirty(rootDir, sourcePath) : false

  // Re-read the document after the modal/InputBox waits: external actors
  // (formatters, git checkout, agents) can rewrite the buffer while the user
  // sits in the dialogs, and the record's hash, anchor, and supersede set
  // must reflect the text at write time, not the pre-modal snapshot.
  const finalDocText = doc.getText()
  const finalExisting = currentResolved(ctx, rootDir, sourcePath, finalDocText)

  const rec = buildRecord({
    id: randomUUID(), author, createdAt: new Date().toISOString(),
    commit, dirty, kind, symbol, range, docText: finalDocText,
    comment: comment || undefined,
    existingCurrent: finalExisting,
  })
  try {
    await appendLine(rootDir, sourcePath, authorSlug(author.email), rec)
  } catch (err) {
    void vscode.window.showErrorMessage(`Vouch: failed to write review — ${String(err)}`)
    return
  }
  await ctx.reload()
  refresh()
}

async function unvouch(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return
  const line = editor.selection.active.line + 1
  const docText = editor.document.getText()
  const targets = currentResolved(ctx, rootDir, sourcePath, docText).filter(e =>
    e.record.author.email === author.email &&
    (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line])))
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Vouch: none of your reviews cover this line.')
    return
  }
  try {
    for (const t of targets) {
      const tomb: Tombstone = { id: randomUUID(), author, createdAt: new Date().toISOString(),
        revokes: t.record.id, reason: 'unvouch' }
      await appendLine(rootDir, sourcePath, authorSlug(author.email), tomb)
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Vouch: failed to write unvouch — ${String(err)}`)
    return
  }
  await ctx.reload()
  refresh()
}

export function registerCommands(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void, pipeline: StatusPipeline,
): void {
  const reg = (id: string, fn: () => Promise<void> | void): void => {
    extCtx.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  const reg2 = (id: string, fn: (arg: string) => Promise<void> | void): void => {
    extCtx.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  reg('vouch.init', async () => {
    const st = await editorState(ctx)
    const rootDir = st?.rootDir ?? ctx.roots[0]?.rootDir
    if (!rootDir) return
    await initVouch(rootDir)
    void vscode.window.showInformationMessage(`Vouch: initialized in ${rootDir}`)
  })
  reg('vouch.selection', () => attest(extCtx, ctx, refresh, pipeline, 'selection'))
  reg('vouch.function', () => attest(extCtx, ctx, refresh, pipeline, 'function'))
  reg('vouch.class', () => attest(extCtx, ctx, refresh, pipeline, 'class'))
  reg('vouch.file', () => attest(extCtx, ctx, refresh, pipeline, 'file'))
  reg('vouch.unvouch', () => unvouch(extCtx, ctx, refresh))
  reg2('vouch.showDiff', (recordId: string) => showDiff(ctx, pipeline, recordId))
  reg2('vouch.openTimeline', (recordId: string) => openTimeline(ctx, recordId))
  reg2('vouch.openCommitOnWeb', async (recordId: string) => {
    const found = findRecord(ctx, recordId)
    if (!found?.record.commit) {
      void vscode.window.showInformationMessage('Vouch: no commit recorded.'); return
    }
    // Defense-in-depth: commit values come from shared, cross-user .vouch/
    // records and are otherwise untrusted (see core/hovermd.ts isValidSha).
    // Never hand an unvalidated value to openExternal.
    if (!isValidSha(found.record.commit)) {
      void vscode.window.showInformationMessage('Vouch: invalid commit reference.'); return
    }
    const remote = await remoteUrl(found.rootDir)
    const url = remote ? commitUrl(remote, found.record.commit) : null
    if (!url) { void vscode.window.showInformationMessage('Vouch: no recognizable git remote.'); return }
    void vscode.env.openExternal(vscode.Uri.parse(url))
  })

  reg2('vouch.reReview', async (recordId?: string) => {
    const st = await editorState(ctx)
    if (!st) return
    const { editor, rootDir, sourcePath } = st
    const author = await resolveAuthor(extCtx, rootDir)
    if (!author) return
    const docText = editor.document.getText()
    const resolved = currentResolved(ctx, rootDir, sourcePath, docText)
    const line = editor.selection.active.line + 1
    const target = recordId
      ? resolved.find(e => e.record.id === recordId)
      : resolved.find(e => e.record.author.email === author.email &&
          e.res.status === 'dismissed' &&
          (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line])))
    if (!target) {
      void vscode.window.showInformationMessage('Vouch: no dismissed review of yours here.')
      return
    }

    if (target.record.kind === 'file') {
      await vscode.commands.executeCommand('vouch.file'); return
    }
    if (target.record.symbol) {
      const symbols = await documentSymbols(editor.document.uri)
      const node = resolveSymbolPath(symbols, target.record.symbol)
      if (node) {
        editor.selection = new vscode.Selection(node.range[0] - 1, 0, node.range[1] - 1, 0)
        await vscode.commands.executeCommand(
          target.record.kind === 'class' ? 'vouch.class' : 'vouch.function')
        return
      }
    }
    // free-form (or symbol gone): preselect displayed range, ask user to confirm/adjust
    const [s, e] = target.res.effectiveRange
    editor.selection = new vscode.Selection(s - 1, 0, e - 1, 0)
    editor.revealRange(new vscode.Range(s - 1, 0, e - 1, 0))
    const choice = await vscode.window.showInformationMessage(
      'Vouch: confirm or adjust the selection, then re-review.', 'Re-review selection')
    if (choice === 'Re-review selection') {
      await vscode.commands.executeCommand('vouch.selection')
    }
  })

  reg('vouch.reattach', async () => {
    for (const root of ctx.roots) {
      const orphans = root.store.orphans(p => fs.existsSync(path.join(root.rootDir, p)))
      if (orphans.length === 0) continue
      const oldPath = await vscode.window.showQuickPick(orphans,
        { placeHolder: 'Vouch: orphaned reviews — pick the old path to re-attach' })
      if (!oldPath) return
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, defaultUri: vscode.Uri.file(root.rootDir),
        openLabel: 'Re-attach reviews to this file' })
      const newUri = picked?.[0]
      if (!newUri) return
      const newSourcePath = ctx.sourcePathOf(newUri)
      if (!newSourcePath) {
        void vscode.window.showWarningMessage('Vouch: target must be inside the workspace.'); return
      }
      const author = await resolveAuthor(extCtx, root.rootDir)
      if (!author) return
      const state = root.store.stateFor(oldPath)
      if (!state) return
      const { copies, tombstones } = buildReattachLines(
        state.current, newSourcePath, () => randomUUID(), new Date().toISOString(), author)
      try {
        // Tombstones to the OLD path first, then copies to the new path: if the
        // process dies mid-loop, the worst case is reviews are revoked but not
        // yet re-created (temporarily missing coverage) rather than live in
        // both places at once (duplicated, falsely-"reviewed" coverage).
        for (const t of tombstones) {
          await appendLine(root.rootDir, oldPath, authorSlug(author.email), t)
        }
        for (const c of copies) {
          await appendLine(root.rootDir, newSourcePath, authorSlug(c.author.email), c)
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Vouch: re-attach failed — ${String(err)}`)
        return
      }
      await ctx.reload()
      refresh()
      return
    }
    void vscode.window.showInformationMessage('Vouch: no orphaned reviews.')
  })
}
