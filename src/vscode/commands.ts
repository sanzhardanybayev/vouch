import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  buildRecord,
  buildReattachLines,
  overlaps,
  rebaseRange,
  supersedeCandidates,
} from '../core/attest'
import { prefillComment, summarizeCandidates } from '../core/consolidate'
import {
  buildLineIndex,
  enclosingItem,
  enclosingSymbol,
  enclosingSymbolOfRange,
  enclosingSymbolWhere,
  hashRangeOfText,
  resolveRecord,
  resolveSymbolPathAll,
  type SymbolNode,
} from '../core/anchor'
import { normalizeEol, splitLines } from '../core/text'
import { authorSlug, normalizeEmail } from '../core/paths'
import { isKnownKind } from '../core/records'
import type { RustItem } from '../core/rust'
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

async function resolveAuthor(extCtx: vscode.ExtensionContext, cwd: string): Promise<Author | null> {
  const fromGit = await identity(cwd)
  if (fromGit) return fromGit
  const saved = extCtx.globalState.get<Author>('vouch.identity')
  if (saved) return saved
  const name = await vscode.window.showInputBox({
    prompt: 'Vouch: your name (no git identity found)',
  })
  if (!name) return null
  const email = await vscode.window.showInputBox({ prompt: 'Vouch: your email' })
  if (!email) return null
  const author = { name, email }
  await extCtx.globalState.update('vouch.identity', author)
  return author
}

/** Shared state each command needs about the active editor. */
async function editorState(ctx: VouchContext): Promise<{
  editor: vscode.TextEditor
  rootDir: string
  sourcePath: string
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

// Resolve a file's current records against given text. `symbols` MUST be the
// same symbol input the visible surfaces use (documentSymbols(uri), or null
// when unavailable) - resolving symbol-blind here would place a record at a
// different location than the gutter shows and let a supersede/unvouch act on
// the wrong one.
export function currentResolved(
  ctx: VouchContext,
  rootDir: string,
  sourcePath: string,
  docText: string,
  symbols: SymbolNode[] | null = null,
): { record: ReviewRecord; res: ReturnType<typeof resolveRecord> }[] {
  const root = ctx.roots.find((r) => r.rootDir === rootDir)
  const state = root?.store.stateFor(sourcePath)
  if (!state) return []
  const index = buildLineIndex(docText)
  return state.current
    .filter(isKnownKind)
    .map((record) => ({ record, res: resolveRecord(record, docText, symbols, index) }))
}

// Rust item reviews write the existing record kinds - macros are
// function-like, every other item scope is a class-like container - so the
// on-disk format is unchanged and teammates on older versions render them
// (docs/adr/0003). The item only decides WHICH symbol gets picked.
export const RUST_ITEM_COMMANDS: Record<RustItem, { command: string; kind: RecordKind }> = {
  struct: { command: 'vouch.struct', kind: 'class' },
  enum: { command: 'vouch.enum', kind: 'class' },
  trait: { command: 'vouch.trait', kind: 'class' },
  impl: { command: 'vouch.impl', kind: 'class' },
  mod: { command: 'vouch.mod', kind: 'class' },
  macro: { command: 'vouch.macro', kind: 'function' },
}

async function attest(
  extCtx: vscode.ExtensionContext,
  ctx: VouchContext,
  refresh: () => void,
  pipeline: StatusPipeline,
  kind: RecordKind,
  supersedeId?: string,
  item?: RustItem,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const doc = editor.document
  if (item && doc.languageId !== 'rust') {
    void vscode.window.showInformationMessage(
      `Vouch: "Review enclosing ${item}" works in Rust files only.`,
    )
    return
  }

  // Snapshot: text, range, and symbols captured BEFORE any dialog opens.
  // The snapshot is what the user actually read - the record must attest to
  // it, never to whatever the buffer holds after the dialogs.
  const snapshotText = doc.getText()
  const snapshotVersion = doc.version
  let snapshotSymbols = await documentSymbols(doc.uri)
  // One short retry covers a still-warming language server, so a review taken
  // right after opening a file still gets its location anchor instead of
  // falling back to a content-only record.
  if (!snapshotSymbols) {
    await new Promise((r) => setTimeout(r, 300))
    snapshotSymbols = await documentSymbols(doc.uri)
  }
  // enclosingSymbol below intersects snapshot-coordinate ranges with this
  // symbol tree; if an external edit landed during the awaits, those
  // coordinates no longer describe the same code. Bail before writing
  // anything derived from a stale pairing.
  if (doc.version !== snapshotVersion) {
    void vscode.window.showWarningMessage(
      'Vouch: the file changed while starting the review - try again.',
    )
    return
  }
  let range: [number, number] | undefined
  let symbol: string | undefined
  let anchorSymbol: string | undefined
  if (kind === 'selection') {
    const sel = editor.selection
    range = [sel.start.line + 1, sel.end.line + 1]
    anchorSymbol = snapshotSymbols
      ? (enclosingSymbolOfRange(snapshotSymbols, range, 'any')?.path ?? '')
      : undefined
  } else if (kind === 'function' || kind === 'class') {
    const line = editor.selection.active.line + 1
    const found = !snapshotSymbols
      ? null
      : item
        ? enclosingItem(snapshotSymbols, line, item)
        : enclosingSymbol(snapshotSymbols, line, kind)
    if (!found) {
      void vscode.window.showInformationMessage(
        `Vouch: no enclosing ${item ?? kind} symbol — select lines and use "Review selected lines".`,
      )
      return
    }
    range = found.range
    symbol = found.path
  }

  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return

  const docText = snapshotText
  const existing = currentResolved(ctx, rootDir, sourcePath, docText, snapshotSymbols)
  const candidates = supersedeCandidates({ author, kind, symbol, range, existingCurrent: existing })
  const summary = summarizeCandidates(candidates)

  let prefill = ''
  // Confirm before superseding a record whose location could not be proven
  // (ambiguous), not only comment/dismissed ones - otherwise a symbol-blind
  // or duplicate-content record could be silently revoked by a new review.
  if (
    candidates.length > 0 &&
    (summary.withComments > 0 || summary.dismissed > 0 || summary.ambiguous > 0)
  ) {
    // Modal text is counts only: candidate symbols/comments are untrusted
    // cross-user data and must never be interpolated into message/detail.
    const message = `Vouching this ${kind} supersedes ${summary.total} of your reviews.`
    const detailParts: string[] = []
    if (summary.withComments > 0)
      detailParts.push(`${summary.withComments} of them carry comments.`)
    if (summary.dismissed > 0) {
      detailParts.push(`${summary.dismissed} are dismissed - code changed since you reviewed them.`)
    }
    if (summary.ambiguous > 0) {
      detailParts.push(
        `${summary.ambiguous} match more than one location - their exact spot is unverified.`,
      )
    }
    const detail = detailParts.join('\n')
    // Cycle through ALL dismissed candidates on repeated "View diff" clicks;
    // stopping at the first would let the rest be superseded sight unseen.
    const dismissedCandidates = candidates.filter((c) => c.res.status === 'dismissed')
    let diffCursor = 0
    let inspecting = false
    for (;;) {
      const items: string[] =
        summary.withComments > 0
          ? ['Copy comments & continue', 'Continue without copying']
          : ['Continue']
      if (summary.dismissed > 0) items.push('View diff')
      const choice = inspecting
        ? await vscode.window.showWarningMessage(
            `${message} ${detail.replace(/\n/g, ' ')}`.trim(),
            ...items,
          )
        : await vscode.window.showWarningMessage(message, { modal: true, detail }, ...items)
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
    prompt: 'Vouch: optional comment (Enter to skip)',
    value: prefill,
  })
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
  const finalVersion = doc.version
  let finalRange = range
  if (kind === 'file') {
    if (normalizeEol(finalDocText) !== normalizeEol(snapshotText)) {
      void vscode.window.showWarningMessage(
        'Vouch: the file changed while the dialog was open - review it again.',
      )
      return
    }
  } else {
    const rebased = rebaseRange(snapshotText, range!, finalDocText)
    if (!rebased) {
      void vscode.window.showWarningMessage(
        'Vouch: the selected code changed while the dialog was open - re-select and review again.',
      )
      return
    }
    finalRange = rebased
  }
  // Resolve the supersede set against the SAME symbol-aware view the surfaces
  // use; a symbol-blind pass could enclose a record the gutter places
  // elsewhere and silently revoke it. Symbols recomputed on the final text
  // (the buffer may have shifted since the snapshot).
  const finalSymbols = await documentSymbols(doc.uri)
  // Symbols are computed from the live buffer; if it moved during the await,
  // finalDocText and the symbol tree describe different states.
  if (doc.version !== finalVersion) {
    void vscode.window.showWarningMessage(
      'Vouch: the file changed while the dialog was open - review it again.',
    )
    return
  }
  const finalExisting = currentResolved(ctx, rootDir, sourcePath, finalDocText, finalSymbols)

  const rec = buildRecord({
    id: randomUUID(),
    author,
    createdAt: new Date().toISOString(),
    commit,
    dirty,
    kind,
    symbol,
    anchorSymbol,
    range: finalRange,
    docText: finalDocText,
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
  extCtx: vscode.ExtensionContext,
  ctx: VouchContext,
  refresh: () => void,
  pipeline: StatusPipeline,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return
  const line = editor.selection.active.line + 1
  // Resolve through the pipeline so "which line covers this record" matches
  // the gutter/hover exactly - a symbol-blind pass could place a record on a
  // different line and answer "none of your reviews cover this line" over its
  // own orange mark.
  const targets = (await pipeline.statusFor(editor.document)).entries.filter(
    (e) =>
      normalizeEmail(e.record.author.email) === normalizeEmail(author.email) &&
      (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line])),
  )
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Vouch: none of your reviews cover this line.')
    return
  }
  try {
    for (const t of targets) {
      const tomb: Tombstone = {
        id: randomUUID(),
        author,
        createdAt: new Date().toISOString(),
        revokes: t.record.id,
        reason: 'unvouch',
      }
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
  extCtx: vscode.ExtensionContext,
  ctx: VouchContext,
  refresh: () => void,
  pipeline: StatusPipeline,
): void {
  const reg = (id: string, fn: () => Promise<void> | void): void => {
    extCtx.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  const reg2 = (id: string, fn: (arg: string) => Promise<void> | void): void => {
    extCtx.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  reg('vouch.init', async () => {
    const editor = vscode.window.activeTextEditor
    const rootDir = (editor && ctx.rootFor(editor.document.uri)?.rootDir) ?? ctx.roots[0]?.rootDir
    if (!rootDir) return
    await initVouch(rootDir)
    // Flip the root live deterministically: init creates no .jsonl, so no
    // watcher will fire for it — the reload's onDidChange lets the sidebar
    // pick up the new .vouch/ dir and start its tracked-file scan.
    await ctx.reload()
    refresh()
    void vscode.window.showInformationMessage(`Vouch: initialized in ${rootDir}`)
  })
  // The optional argument threads an explicit supersede target from the
  // re-review/resolve flows; menu invocations may pass a Uri or nothing, so
  // only a string is accepted (buildRecord re-validates ownership anyway).
  const attestCmd =
    (kind: RecordKind) =>
    (arg?: unknown): Promise<void> =>
      attest(extCtx, ctx, refresh, pipeline, kind, typeof arg === 'string' ? arg : undefined)
  reg2('vouch.selection', attestCmd('selection'))
  reg2('vouch.function', attestCmd('function'))
  reg2('vouch.class', attestCmd('class'))
  reg2('vouch.file', attestCmd('file'))
  for (const [item, { command, kind }] of Object.entries(RUST_ITEM_COMMANDS)) {
    reg2(command, (arg?: unknown) =>
      attest(
        extCtx,
        ctx,
        refresh,
        pipeline,
        kind,
        typeof arg === 'string' ? arg : undefined,
        item as RustItem,
      ),
    )
  }
  reg('vouch.unvouch', () => unvouch(extCtx, ctx, refresh, pipeline))
  reg2('vouch.showDiff', (recordId: string) => showDiff(ctx, pipeline, recordId))
  reg2('vouch.openTimeline', (recordId: string) => openTimeline(ctx, pipeline, recordId))

  // CodeLens groups can mix records from several authors and scopes on one
  // line — diffing "the group" means picking which record first.
  reg2('vouch.pickDiff', async (arg?: unknown) => {
    const ids = Array.isArray(arg) ? arg.filter((x): x is string => typeof x === 'string') : []
    if (ids.length === 0) return
    if (ids.length === 1) {
      await showDiff(ctx, pipeline, ids[0]!)
      return
    }
    const items = ids.flatMap((id) => {
      const found = findRecord(ctx, id)
      if (!found) return []
      const r = found.record
      const scope =
        r.kind === 'file'
          ? 'file'
          : (r.symbol ?? (r.range ? `L${r.range[0]}-${r.range[1]}` : r.kind))
      return [{ label: `${r.author.name} - ${r.kind} ${scope}`, id }]
    })
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Vouch: pick the review to diff',
    })
    if (picked) await showDiff(ctx, pipeline, picked.id)
  })

  // One-click resolution for an ambiguous review: the author picks which of
  // the structurally valid locations is the one they actually reviewed, and
  // a replacement record (same comment, freshly captured location identity)
  // supersedes the ambiguous one.
  reg2('vouch.resolveAmbiguous', async (arg?: unknown) => {
    // Accept one id (hover/timeline) or several (a CodeLens group can anchor
    // more than one ambiguous record on a line) - resolve the one the
    // invoking user owns so the lens never dead-ends on a teammate's record.
    const ids =
      typeof arg === 'string'
        ? [arg]
        : Array.isArray(arg)
          ? arg.filter((x): x is string => typeof x === 'string')
          : []
    if (ids.length === 0) return
    const candidatesFound = ids
      .map((id) => findRecord(ctx, id))
      .filter((f): f is NonNullable<typeof f> => !!f)
    if (candidatesFound.length === 0) {
      void vscode.window.showWarningMessage('Vouch: record not found.')
      return
    }
    const { rootDir, sourcePath } = candidatesFound[0]!
    const author = await resolveAuthor(extCtx, rootDir)
    if (!author) return
    const found =
      candidatesFound.find(
        (f) => normalizeEmail(f.record.author.email) === normalizeEmail(author.email),
      ) ?? candidatesFound[0]!
    const recordId = found.record.id
    if (normalizeEmail(found.record.author.email) !== normalizeEmail(author.email)) {
      void vscode.window.showInformationMessage(
        `Vouch: only ${found.record.author.name} can resolve this review - ` +
          're-review the code yourself instead.',
      )
      return
    }
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(rootDir, sourcePath)))
    } catch {
      void vscode.window.showWarningMessage(`Vouch: ${sourcePath} not found.`)
      return
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    const status = await pipeline.statusFor(doc)
    const entry = status.entries.find((e) => e.record.id === recordId)
    const candidates = entry?.res.status === 'ambiguous' ? (entry.res.candidates ?? []) : []
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
    const picked = await new Promise<Item | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<Item>()
      qp.items = items
      qp.placeholder =
        candidates.length === 1
          ? 'Vouch: one possible location - confirm it is the one you reviewed'
          : `Vouch: ${candidates.length} identical matches - pick the one you reviewed`
      qp.onDidChangeActive((active) => {
        const it = active[0]
        if (!it) return
        const range = new vscode.Range(it.range[0] - 1, 0, it.range[1] - 1, 0)
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        editor.selection = new vscode.Selection(range.start, range.end)
      })
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0])
        qp.hide()
      })
      qp.onDidHide(() => {
        resolve(undefined)
        qp.dispose()
      })
      qp.show()
    })
    if (!picked) return

    // Write-time guard: the buffer may have changed while the picker was
    // open, and the candidate ranges came from a possibly-stale pipeline
    // pass. Every legitimate candidate's window hashes to the record's own
    // content hash, so one check closes both races.
    const finalText = doc.getText()
    const finalVersion = doc.version
    if (hashRangeOfText(finalText, picked.range).hash !== found.record.hash) {
      void vscode.window.showWarningMessage(
        'Vouch: the file changed while the dialog was open - resolve again.',
      )
      refresh()
      return
    }
    const symbols = await documentSymbols(doc.uri)
    // Symbols are computed from the live buffer; if it moved after the hash
    // check, the picked range and the symbol tree describe different states.
    if (doc.version !== finalVersion) {
      void vscode.window.showWarningMessage(
        'Vouch: the file changed while the dialog was open - resolve again.',
      )
      refresh()
      return
    }
    let symbol: string | undefined
    let anchorSymbol: string | undefined
    if (found.record.kind === 'function' || found.record.kind === 'class') {
      // A Rust item record (impl, mod, ...) re-anchors to the same item
      // scope; its kindClass is 'other', so the plain kind test misses it.
      const kind = found.record.kind
      const item =
        symbols && found.record.symbol
          ? resolveSymbolPathAll(symbols, found.record.symbol)[0]?.item
          : undefined
      symbol =
        (symbols
          ? enclosingSymbolWhere(
              symbols,
              picked.range,
              (n) => n.kindClass === kind || (item !== undefined && n.item === item),
            )?.path
          : undefined) ?? found.record.symbol
    } else if (found.record.kind === 'selection') {
      anchorSymbol = symbols
        ? (enclosingSymbolOfRange(symbols, picked.range, 'any')?.path ?? '')
        : undefined
    }
    const commit = (await headSha(rootDir)) ?? ''
    const dirty = commit ? await isDirty(rootDir, sourcePath) : false
    const finalExisting = currentResolved(ctx, rootDir, sourcePath, finalText, symbols)
    const rec = buildRecord({
      id: randomUUID(),
      author,
      createdAt: new Date().toISOString(),
      commit,
      dirty,
      kind: found.record.kind,
      symbol,
      anchorSymbol,
      range: picked.range,
      docText: finalText,
      comment: found.record.comment,
      supersedeId: recordId,
      explicitSupersedeOnly: true,
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
      void vscode.window.showInformationMessage('Vouch: no commit recorded.')
      return
    }
    // Defense-in-depth: commit values come from shared, cross-user .vouch/
    // records and are otherwise untrusted (see core/hovermd.ts isValidSha).
    // Never hand an unvalidated value to openExternal.
    if (!isValidSha(found.record.commit)) {
      void vscode.window.showInformationMessage('Vouch: invalid commit reference.')
      return
    }
    const remote = await remoteUrl(found.rootDir)
    const url = remote ? commitUrl(remote, found.record.commit) : null
    if (!url) {
      void vscode.window.showInformationMessage('Vouch: no recognizable git remote.')
      return
    }
    void vscode.env.openExternal(vscode.Uri.parse(url))
  })

  // The status menu behind a review bar (hover "Actions…" link, editor
  // menu, palette). It offers only the verbs Vouch has - re-review, resolve,
  // revoke, inspect: a status is never set by hand (docs/adr/0002).
  // Accepts a record id (hover link) or nothing (reviews at the cursor).
  reg2('vouch.actions', async (arg?: unknown) => {
    let doc: vscode.TextDocument
    let rootDir: string
    let sourcePath: string
    let line: number | undefined
    if (typeof arg === 'string') {
      const found = findRecord(ctx, arg)
      if (!found) {
        void vscode.window.showWarningMessage('Vouch: record not found.')
        return
      }
      ;({ rootDir, sourcePath } = found)
      try {
        doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(rootDir, sourcePath)),
        )
      } catch {
        void vscode.window.showWarningMessage(`Vouch: ${sourcePath} not found.`)
        return
      }
    } else {
      const st = await editorState(ctx)
      if (!st) return
      ;({ rootDir, sourcePath } = st)
      doc = st.editor.document
      line = st.editor.selection.active.line + 1
    }
    const entries = (await pipeline.statusFor(doc)).entries.filter((e) =>
      typeof arg === 'string'
        ? e.record.id === arg
        : e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line!, line!]),
    )
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Vouch: no reviews cover this line.')
      return
    }
    const describe = (e: (typeof entries)[number]): string => {
      const r = e.record
      const scope =
        r.kind === 'file'
          ? 'file'
          : `${r.kind} ${r.symbol ?? `L${e.res.effectiveRange[0]}-${e.res.effectiveRange[1]}`}`
      return `${e.res.status} - ${r.author.name} - ${scope}`
    }
    let entry = entries[0]!
    if (entries.length > 1) {
      // Labels carry untrusted record text, but a QuickPick renders plain
      // text only (no markdown, no links).
      const picked = await vscode.window.showQuickPick(
        entries.map((e) => ({ label: describe(e), entry: e })),
        { placeHolder: 'Vouch: several reviews cover this line - pick one' },
      )
      if (!picked) return
      entry = picked.entry
    }
    const author = await resolveAuthor(extCtx, rootDir)
    if (!author) return
    const id = entry.record.id
    const mine = normalizeEmail(entry.record.author.email) === normalizeEmail(author.email)
    type Action = vscode.QuickPickItem & { run: () => Thenable<unknown> | Promise<unknown> }
    const actions: Action[] = []
    if (mine && entry.res.status === 'ambiguous') {
      actions.push({
        label: '$(pin) Resolve',
        detail: 'Pin this review to the location you actually reviewed',
        run: () => vscode.commands.executeCommand('vouch.resolveAmbiguous', id),
      })
    }
    actions.push({
      label: mine ? '$(check) Re-review' : '$(check) Review it yourself',
      detail: mine
        ? 'Vouch again for the code as it is now; replaces this review'
        : `Add your own review next to ${entry.record.author.name}'s`,
      run: () => vscode.commands.executeCommand('vouch.reReview', id),
    })
    if (mine) {
      actions.push({
        label: '$(trash) Revoke my review',
        detail: 'The code becomes honestly unreviewed; history keeps the record',
        run: async () => {
          const tomb: Tombstone = {
            id: randomUUID(),
            author,
            createdAt: new Date().toISOString(),
            revokes: id,
            reason: 'unvouch',
          }
          try {
            await appendLine(rootDir, sourcePath, authorSlug(author.email), tomb)
          } catch (err) {
            void vscode.window.showErrorMessage(`Vouch: failed to revoke — ${String(err)}`)
            return
          }
          await ctx.reload()
          refresh()
        },
      })
    }
    actions.push(
      {
        label: '$(diff) Diff since review',
        run: () => vscode.commands.executeCommand('vouch.showDiff', id),
      },
      {
        label: '$(history) Open timeline',
        run: () => vscode.commands.executeCommand('vouch.openTimeline', id),
      },
    )
    if (entry.record.commit && isValidSha(entry.record.commit)) {
      actions.push({
        label: '$(link-external) Open review commit on web',
        run: () => vscode.commands.executeCommand('vouch.openCommitOnWeb', id),
      })
    }
    const choice = await vscode.window.showQuickPick(actions, {
      placeHolder: `Vouch: ${describe(entry)}`,
    })
    if (choice) await choice.run()
  })

  // Accepts a record id (hover/timeline links), a {line} hint (CodeLens
  // groups), or nothing (cursor position). The resolved target's id is
  // threaded through the delegated attest as an explicit supersede target so
  // re-reviewing at a MOVED location still replaces the old record instead
  // of leaving a duplicate amber/orange marker behind.
  reg2('vouch.reReview', async (arg?: unknown) => {
    const recordId = typeof arg === 'string' ? arg : undefined
    const lineHint =
      !!arg && typeof arg === 'object' && typeof (arg as { line?: unknown }).line === 'number'
        ? (arg as { line: number }).line
        : undefined

    // A recordId can arrive from the timeline of a file that is NOT the active
    // editor (or with no editor focused at all), so resolve it to its own
    // file rather than trusting the active editor. Cursor/line-hint
    // invocations stay editor-relative.
    let editor: vscode.TextEditor
    let rootDir: string
    if (recordId) {
      const found = findRecord(ctx, recordId)
      if (!found) {
        void vscode.window.showWarningMessage('Vouch: record not found.')
        return
      }
      rootDir = found.rootDir
      const sourcePath = found.sourcePath
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(rootDir, sourcePath)),
        )
        editor = await vscode.window.showTextDocument(doc, { preview: false })
      } catch {
        void vscode.window.showWarningMessage(`Vouch: ${sourcePath} not found.`)
        return
      }
    } else {
      const st = await editorState(ctx)
      if (!st) return
      editor = st.editor
      rootDir = st.rootDir
    }

    const author = await resolveAuthor(extCtx, rootDir)
    if (!author) return
    const resolved = (await pipeline.statusFor(editor.document)).entries
    const line = lineHint ?? editor.selection.active.line + 1
    const actionable = (e: {
      record: ReviewRecord
      res: { status: string; effectiveRange: [number, number] }
    }): boolean =>
      normalizeEmail(e.record.author.email) === normalizeEmail(author.email) &&
      (e.res.status === 'dismissed' || e.res.status === 'ambiguous') &&
      (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line]))
    const target = recordId
      ? resolved.find((e) => e.record.id === recordId)
      : resolved.find(actionable)
    if (!target) {
      void vscode.window.showInformationMessage(
        'Vouch: no dismissed or ambiguous review of yours here.',
      )
      return
    }

    if (target.record.kind === 'file') {
      await vscode.commands.executeCommand('vouch.file', target.record.id)
      return
    }
    // Whole-symbol re-review is only ever right for records that COVER a
    // symbol AND whose symbol resolves to exactly one place. A selection
    // record, or a duplicate/absent symbol, must not escalate into a
    // function-wide attestation of code the user never brought on screen.
    if (
      (target.record.kind === 'function' || target.record.kind === 'class') &&
      target.record.symbol
    ) {
      const symbols = await documentSymbols(editor.document.uri)
      const matches = symbols ? resolveSymbolPathAll(symbols, target.record.symbol) : []
      if (matches.length === 1) {
        const node = matches[0]!
        const symRange = new vscode.Range(node.range[0] - 1, 0, node.range[1] - 1, 0)
        editor.selection = new vscode.Selection(symRange.start, symRange.end)
        editor.revealRange(symRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        // Re-run the command that picks this symbol: a function/class node
        // takes its classic command, a Rust impl/mod (kindClass 'other')
        // its item command.
        const command =
          node.kindClass === target.record.kind
            ? `vouch.${target.record.kind}`
            : node.item
              ? RUST_ITEM_COMMANDS[node.item].command
              : `vouch.${target.record.kind}`
        await vscode.commands.executeCommand(command, target.record.id)
        return
      }
    }
    // free-form (or symbol gone/duplicated): preselect displayed range, ask
    // the user to confirm/adjust, so they attest the location they saw.
    const [s, e] = target.res.effectiveRange
    editor.selection = new vscode.Selection(s - 1, 0, e - 1, 0)
    editor.revealRange(
      new vscode.Range(s - 1, 0, e - 1, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    )
    const choice = await vscode.window.showInformationMessage(
      'Vouch: confirm or adjust the selection, then re-review.',
      'Re-review selection',
    )
    if (choice === 'Re-review selection') {
      await vscode.commands.executeCommand('vouch.selection', target.record.id)
    }
  })

  reg('vouch.reattach', async () => {
    for (const root of ctx.roots) {
      const orphans = root.store.orphans((p) => fs.existsSync(path.join(root.rootDir, p)))
      if (orphans.length === 0) continue
      const oldPath = await vscode.window.showQuickPick(orphans, {
        placeHolder: 'Vouch: orphaned reviews — pick the old path to re-attach your reviews',
      })
      if (!oldPath) return
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: vscode.Uri.file(root.rootDir),
        openLabel: 'Re-attach reviews to this file',
      })
      const newUri = picked?.[0]
      if (!newUri) return
      const newSourcePath = ctx.sourcePathOf(newUri)
      if (!newSourcePath) {
        void vscode.window.showWarningMessage('Vouch: target must be inside the workspace.')
        return
      }
      const author = await resolveAuthor(extCtx, root.rootDir)
      if (!author) return
      const state = root.store.stateFor(oldPath)
      if (!state) return
      // Re-attach moves only YOUR records: revocation is author-bound (a
      // cross-author tombstone would be ignored on load), so moving a
      // teammate's review is structurally impossible - explain instead of
      // silently doing nothing.
      const mine = state.current.filter(
        (r) => normalizeEmail(r.author.email) === normalizeEmail(author.email),
      )
      if (mine.length === 0) {
        const owners = [...new Set(state.current.map((r) => r.author.name))].join(', ')
        void vscode.window.showInformationMessage(
          `Vouch: the ${state.current.length} review(s) on ${oldPath} belong to ` +
            `${owners} - each reviewer re-attaches their own records.`,
        )
        return
      }
      const { copies, tombstones } = buildReattachLines(
        mine,
        newSourcePath,
        () => randomUUID(),
        new Date().toISOString(),
        author,
      )
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
