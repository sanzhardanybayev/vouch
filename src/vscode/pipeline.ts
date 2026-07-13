import * as vscode from 'vscode'
import { resolveRecord, resolveSymbolPath, type Resolution } from '../core/anchor'
import { fileCoverage, type FileCoverage } from '../core/coverage'
import type { ReviewRecord } from '../core/types'
import type { VouchContext } from './context'
import { documentSymbols } from './symbols'

export interface FileStatus {
  entries: { record: ReviewRecord; res: Resolution }[]
  coverage: FileCoverage | null
}

export class StatusPipeline {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidUpdate = this.emitter.event
  private cache = new WeakMap<vscode.TextDocument, { version: number; gen: number; status: FileStatus }>()
  private gen = 0
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly ctx: VouchContext, subscriptions: vscode.Disposable[]) {
    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      ctx.onDidChange(() => { this.invalidate(); this.refreshVisible() }),
    )
  }

  invalidate(): void { this.gen++ }

  refreshVisible(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      void this.statusFor(ed.document)
        .then(() => this.emitter.fire(ed.document.uri))
        .catch(() => {})
    }
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString()
    const t = this.timers.get(key)
    if (t) clearTimeout(t)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      void this.statusFor(doc)
        .then(() => this.emitter.fire(doc.uri))
        .catch(() => {})
    }, 300))
  }

  async statusFor(doc: vscode.TextDocument): Promise<FileStatus> {
    const hit = this.cache.get(doc)
    if (hit && hit.version === doc.version && hit.gen === this.gen) return hit.status

    // Captured synchronously, before any await below, so an edit or
    // invalidate() that lands during the await can't be mistaken for the
    // state this computation actually reflects.
    const versionAtStart = doc.version
    const genAtStart = this.gen

    const empty: FileStatus = { entries: [], coverage: null }
    const root = this.ctx.rootFor(doc.uri)
    const sourcePath = this.ctx.sourcePathOf(doc.uri)
    if (!root || !sourcePath) return empty
    const state = root.store.stateFor(sourcePath)
    if (!state || state.current.length === 0) return empty

    const docText = doc.getText()
    const needSymbols = state.current.some(r => r.symbol)
    const symbols = needSymbols ? await documentSymbols(doc.uri) : []

    const entries = state.current.map(record => {
      const symRange = record.symbol
        ? resolveSymbolPath(symbols, record.symbol)?.range ?? null : null
      return { record, res: resolveRecord(record, docText, symRange) }
    })
    const status: FileStatus = { entries, coverage: fileCoverage(entries, docText) }
    // If the document or invalidation generation moved on while we were
    // awaiting symbols, this result is already stale — return it (better
    // than nothing) but don't let it poison the cache for the next call.
    if (doc.version !== versionAtStart || this.gen !== genAtStart) return status
    this.cache.set(doc, { version: versionAtStart, gen: genAtStart, status })
    return status
  }
}
