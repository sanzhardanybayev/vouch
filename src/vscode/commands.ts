import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildRecord, buildReattachLines, overlaps, rebaseRange, supersedeCandidates } from '../core/attest'
import { prefillComment, summarizeCandidates } from '../core/consolidate'
import { enclosingSymbol, enclosingSymbolOfRange, hashRangeOfText, resolveRecord, resolveSymbolPath } from '../core/anchor'
import { normalizeEol, splitLines } from '../core/text'
import { authorSlug, normalizeEmail } from '../core/paths'
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

// The selection's enclosing function/class at review time, as location
// identity for the record. One short retry covers a still-warming language
// server; after that, null-from-provider means the record stays content-only
// (a small, explicit unprotected class), while a provider that ran and found
// no enclosing symbol yields the top-level sentinel ''.
async function captureAnchorSymbol(
  uri: vscode.Uri, range: [number, number],
): Promise<string | undefined> {
  let symbols = await documentSymbols(uri)
  if (!symbols) {
    await new Promise(r => setTimeout(r, 300))
    symbols = await documentSymbols(uri)
  }
  if (!symbols) return undefined
  return enclosingSymbolOfRange(symbols, range, 'any')?.path ?? ''
}

async function attest(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void,
  pipeline: StatusPipeline, kind: RecordKind, supersedeId?: string,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const doc = editor.document

  // Snapshot: text, range, and symbols captured BEFORE any dialog opens.
  // The snapshot is what the user actually read - the record must attest to
  // it, never to whatever the buffer holds after the dialogs.
  const snapshotText = doc.getText()
  let range: [number, number] | undefined
  let symbol: string | undefined
  let anchorSymbol: string | undefined
  if (kind === 'selection') {
    const sel = editor.selection
    range = [sel.start.line + 1, sel.end.line + 1]
    anchorSymbol = await captureAnchorSymbol(doc.uri, range)
  } else if (kind === 'function' || kind === 'class') {
    const symbols = await documentSymbols(doc.uri)
    const found = symbols ? enclosingSymbol(symbols, editor.selection.active.line + 1, kind) : null
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

  const docText = snapshotText
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
    let inspecting = false
    for (;;) {
      const items: string[] = summary.withComments > 0
        ? ['Copy comments & continue', 'Continue without copying']
        : ['Continue']
      if (summary.dismissed > 0) items.push('View diff')
      const choice = inspecting
        ? await vscode.window.showWarningMessage(
            `${message} ${detail.replace(/\n/g, ' ')}`.trim(), ...items)
        : await vscode.window.showWarningMessage(
            message, { modal: true, detail }, ...items)
      if (choice === undefined) return // Esc/dismiss aborts the vouch
      if (choice === 'View diff') {
        const dismissed = dismissedCandidates[diffCursor % dismissedCandidates.length]
        if (dismissed) {
          diffCursor++
          await showDiff(ctx, pipeline, dismissed.record.id)
        }
        inspecting = true
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

  // Post-dialog guard: external actors (formatters, git checkout, agents)
  // can rewrite the buffer while the user sits in the dialogs. Locate the
  // SNAPSHOT content in the final text - insertions elsewhere just rebase
  // the range (the hashed content is identical by construction), but if the
  // reviewed content itself was edited away or duplicated, abort: a record
  // must never attest to text the user did not read.
  const finalDocText = doc.getText()
  let finalRange = range
  if (kind === 'file') {
    if (normalizeEol(finalDocText) !== normalizeEol(snapshotText)) {
      void vscode.window.showWarningMessage(
        'Vouch: the file changed while the dialog was open - review it again.')
      return
    }
  } else {
    const rebased = rebaseRange(snapshotText, range!, finalDocText)
    if (!rebased) {
      void vscode.window.showWarningMessage(
        'Vouch: the selected code changed while the dialog was open - re-select and review again.')
      return
    }
    finalRange = rebased
  }
  const finalExisting = currentResolved(ctx, rootDir, sourcePath, finalDocText)

  const rec = buildRecord({
    id: randomUUID(), author, createdAt: new Date().toISOString(),
    commit, dirty, kind, symbol, anchorSymbol, range: finalRange, docText: finalDocText,
    comment: comment || undefined,
    supersedeId,
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
    normalizeEmail(e.record.author.email) === normalizeEmail(author.email) &&
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
  // The optional argument threads an explicit supersede target from the
  // re-review/resolve flows; menu invocations may pass a Uri or nothing, so
  // only a string is accepted (buildRecord re-validates ownership anyway).
  const attestCmd = (kind: RecordKind) => (arg?: unknown): Promise<void> =>
    attest(extCtx, ctx, refresh, pipeline, kind, typeof arg === 'string' ? arg : undefined)
  reg2('vouch.selection', attestCmd('selection'))
  reg2('vouch.function', attestCmd('function'))
  reg2('vouch.class', attestCmd('class'))
  reg2('vouch.file', attestCmd('file'))
  reg('vouch.unvouch', () => unvouch(extCtx, ctx, refresh))
  reg2('vouch.showDiff', (recordId: string) => showDiff(ctx, pipeline, recordId))
  reg2('vouch.openTimeline', (recordId: string) => openTimeline(ctx, pipeline, recordId))

  // CodeLens groups can mix records from several authors and scopes on one
  // line — diffing "the group" means picking which record first.
  reg2('vouch.pickDiff', async (arg?: unknown) => {
    const ids = Array.isArray(arg) ? arg.filter((x): x is string => typeof x === 'string') : []
    if (ids.length === 0) return
    if (ids.length === 1) { await showDiff(ctx, pipeline, ids[0]!); return }
    const items = ids.flatMap(id => {
      const found = findRecord(ctx, id)
      if (!found) return []
      const r = found.record
      const scope = r.kind === 'file' ? 'file'
        : r.symbol ?? (r.range ? `L${r.range[0]}-${r.range[1]}` : r.kind)
      return [{ label: `${r.author.name} - ${r.kind} ${scope}`, id }]
    })
    const picked = await vscode.window.showQuickPick(items,
      { placeHolder: 'Vouch: pick the review to diff' })
    if (picked) await showDiff(ctx, pipeline, picked.id)
  })

  // One-click resolution for an ambiguous review: the author picks which of
  // the structurally valid locations is the one they actually reviewed, and
  // a replacement record (same comment, freshly captured location identity)
  // supersedes the ambiguous one.
  reg2('vouch.resolveAmbiguous', async (arg?: unknown) => {
    const recordId = typeof arg === 'string' ? arg : undefined
    if (!recordId) return
    const found = findRecord(ctx, recordId)
    if (!found) { void vscode.window.showWarningMessage('Vouch: record not found.'); return }
    const { rootDir, sourcePath } = found
    const author = await resolveAuthor(extCtx, rootDir)
    if (!author) return
    if (normalizeEmail(found.record.author.email) !== normalizeEmail(author.email)) {
      void vscode.window.showInformationMessage(
        `Vouch: only ${found.record.author.name} can resolve this review - ` +
        're-review the code yourself instead.')
      return
    }
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(rootDir, sourcePath)))
    } catch {
      void vscode.window.showWarningMessage(`Vouch: ${sourcePath} not found.`)
      return
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    const status = await pipeline.statusFor(doc)
    const entry = status.entries.find(e => e.record.id === recordId)
    const candidates = entry?.res.status === 'ambiguous' ? entry.res.candidates ?? [] : []
    if (!entry || candidates.length === 0) {
      void vscode.window.showInformationMessage('Vouch: this review is not ambiguous here anymore.')
      return
    }

    const docLines = splitLines(doc.getText())
    type Item = vscode.QuickPickItem & { range: [number, number] }
    const items: Item[] = candidates.map(([s, e]) => ({
      label: `L${s}-${e}`,
      description: (docLines[s - 1] ?? '').trim().slice(0, 80),
      range: [s, e],
    }))
    const picked = await new Promise<Item | undefined>(resolve => {
      const qp = vscode.window.createQuickPick<Item>()
      qp.items = items
      qp.placeholder = `Vouch: ${candidates.length} identical matches - pick the one you reviewed`
      qp.onDidChangeActive(active => {
        const it = active[0]
        if (!it) return
        const range = new vscode.Range(it.range[0] - 1, 0, it.range[1] - 1, 0)
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        editor.selection = new vscode.Selection(range.start, range.end)
      })
      qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide() })
      qp.onDidHide(() => { resolve(undefined); qp.dispose() })
      qp.show()
    })
    if (!picked) return

    // Write-time guard: the buffer may have changed while the picker was
    // open, and the candidate ranges came from a possibly-stale pipeline
    // pass. Every legitimate candidate's window hashes to the record's own
    // content hash, so one check closes both races.
    const finalText = doc.getText()
    if (hashRangeOfText(finalText, picked.range).hash !== found.record.hash) {
      void vscode.window.showWarningMessage(
        'Vouch: the file changed while the dialog was open - resolve again.')
      refresh()
      return
    }
    const symbols = await documentSymbols(doc.uri)
    let symbol: string | undefined
    let anchorSymbol: string | undefined
    if (found.record.kind === 'function' || found.record.kind === 'class') {
      symbol = (symbols
        ? enclosingSymbolOfRange(symbols, picked.range, found.record.kind)?.path : undefined)
        ?? found.record.symbol
    } else if (found.record.kind === 'selection') {
      anchorSymbol = symbols
        ? enclosingSymbolOfRange(symbols, picked.range, 'any')?.path ?? '' : undefined
    }
    const commit = (await headSha(rootDir)) ?? ''
    const dirty = commit ? await isDirty(rootDir, sourcePath) : false
    const finalExisting = currentResolved(ctx, rootDir, sourcePath, finalText)
    const rec = buildRecord({
      id: randomUUID(), author, createdAt: new Date().toISOString(),
      commit, dirty, kind: found.record.kind, symbol, anchorSymbol,
      range: picked.range, docText: finalText,
      comment: found.record.comment,
      supersedeId: recordId,
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
  })
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

  // Accepts a record id (hover/timeline links), a {line} hint (CodeLens
  // groups), or nothing (cursor position). The resolved target's id is
  // threaded through the delegated attest as an explicit supersede target so
  // re-reviewing at a MOVED location still replaces the old record instead
  // of leaving a duplicate amber/orange marker behind.
  reg2('vouch.reReview', async (arg?: unknown) => {
    const st = await editorState(ctx)
    if (!st) return
    const { editor, rootDir, sourcePath } = st
    const author = await resolveAuthor(extCtx, rootDir)
    if (!author) return
    const docText = editor.document.getText()
    const resolved = currentResolved(ctx, rootDir, sourcePath, docText)
    const recordId = typeof arg === 'string' ? arg : undefined
    const lineHint = !!arg && typeof arg === 'object' && typeof (arg as { line?: unknown }).line === 'number'
      ? (arg as { line: number }).line : undefined
    const line = lineHint ?? editor.selection.active.line + 1
    const actionable = (e: { record: ReviewRecord; res: { status: string; effectiveRange: [number, number] } }): boolean =>
      normalizeEmail(e.record.author.email) === normalizeEmail(author.email) &&
      (e.res.status === 'dismissed' || e.res.status === 'ambiguous') &&
      (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line]))
    const target = recordId
      ? resolved.find(e => e.record.id === recordId)
      : resolved.find(actionable)
    if (!target) {
      void vscode.window.showInformationMessage('Vouch: no dismissed review of yours here.')
      return
    }

    if (target.record.kind === 'file') {
      await vscode.commands.executeCommand('vouch.file', target.record.id); return
    }
    // Whole-symbol re-review is only ever right for records that COVER a
    // symbol. A selection record with an anchor must not escalate into a
    // function-wide attestation the user never read.
    if ((target.record.kind === 'function' || target.record.kind === 'class') && target.record.symbol) {
      const symbols = await documentSymbols(editor.document.uri)
      const node = symbols ? resolveSymbolPath(symbols, target.record.symbol) : null
      if (node) {
        editor.selection = new vscode.Selection(node.range[0] - 1, 0, node.range[1] - 1, 0)
        await vscode.commands.executeCommand(
          target.record.kind === 'class' ? 'vouch.class' : 'vouch.function', target.record.id)
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
      await vscode.commands.executeCommand('vouch.selection', target.record.id)
    }
  })

  reg('vouch.reattach', async () => {
    for (const root of ctx.roots) {
      const orphans = root.store.orphans(p => fs.existsSync(path.join(root.rootDir, p)))
      if (orphans.length === 0) continue
      const oldPath = await vscode.window.showQuickPick(orphans,
        { placeHolder: 'Vouch: orphaned reviews — pick the old path to re-attach your reviews' })
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
      // Re-attach moves only YOUR records: revocation is author-bound (a
      // cross-author tombstone would be ignored on load), so moving a
      // teammate's review is structurally impossible - explain instead of
      // silently doing nothing.
      const mine = state.current.filter(r =>
        normalizeEmail(r.author.email) === normalizeEmail(author.email))
      if (mine.length === 0) {
        const owners = [...new Set(state.current.map(r => r.author.name))].join(', ')
        void vscode.window.showInformationMessage(
          `Vouch: the ${state.current.length} review(s) on ${oldPath} belong to ` +
          `${owners} - each reviewer re-attaches their own records.`)
        return
      }
      const { copies, tombstones } = buildReattachLines(
        mine, newSourcePath, () => randomUUID(), new Date().toISOString(), author)
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
