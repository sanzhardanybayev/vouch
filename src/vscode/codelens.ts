import * as vscode from 'vscode'
import { codeLensTitle, type LensEntry } from '../core/codelens-text'
import type { ReviewRecord } from '../core/types'
import type { Resolution } from '../core/anchor'
import type { StatusPipeline } from './pipeline'

export class VouchCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event

  constructor(private readonly pipeline: StatusPipeline, subscriptions: vscode.Disposable[]) {
    subscriptions.push(
      pipeline.onDidUpdate(() => this.emitter.fire()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vouch.codeLens.enabled')) this.emitter.fire()
      }),
    )
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('vouch').get<boolean>('codeLens.enabled', true)
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.enabled()) return []
    const status = await this.pipeline.statusFor(doc)
    if (status.entries.length === 0) return []

    // Group current records by their anchor's first line.
    const byLine = new Map<number, { record: ReviewRecord; res: Resolution }[]>()
    for (const e of status.entries) {
      const line = e.res.effectiveRange[0]
      const arr = byLine.get(line) ?? []
      arr.push(e)
      byLine.set(line, arr)
    }

    const lenses: vscode.CodeLens[] = []
    const now = new Date().toISOString()
    for (const [line, group] of byLine) {
      const range = new vscode.Range(line - 1, 0, line - 1, 0)
      const rep = group[0]!.record // representative record for command args
      const entries: LensEntry[] = group.map(g => ({
        authorName: g.record.author.name, status: g.res.status, createdAt: g.record.createdAt }))
      const title = codeLensTitle(entries, now)
      if (!title) continue
      lenses.push(new vscode.CodeLens(range, {
        title, command: 'vouch.openTimeline', arguments: [rep.id] }))
      lenses.push(new vscode.CodeLens(range, {
        title: 'Re-review', command: 'vouch.reReview', arguments: [rep.id] }))
      const anyReviewed = group.some(g => g.res.status === 'reviewed')
      if (rep.commit || anyReviewed) {
        lenses.push(new vscode.CodeLens(range, {
          title: 'Diff', command: 'vouch.showDiff', arguments: [rep.id] }))
      }
    }
    return lenses
  }
}
