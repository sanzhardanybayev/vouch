import * as vscode from 'vscode'
import { codeLensTitle, type LensEntry } from '../core/codelens-text'
import type { ReviewRecord } from '../core/types'
import type { Resolution } from '../core/anchor'
import type { StatusPipeline } from './pipeline'

export class VouchCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event

  constructor(
    private readonly pipeline: StatusPipeline,
    subscriptions: vscode.Disposable[],
  ) {
    subscriptions.push(
      pipeline.onDidUpdate(() => this.emitter.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
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
      const entries: LensEntry[] = group.map((g) => ({
        authorName: g.record.author.name,
        status: g.res.status,
        createdAt: g.record.createdAt,
      }))
      const title = codeLensTitle(entries, now)
      if (!title) continue

      // The title lens advertises a verb — route it to the matching action.
      // An ambiguous group's "resolve" goes straight to the resolve flow for
      // the ambiguous record itself; anything else opens the timeline (a
      // whole-file view, safe regardless of which record represents it).
      const ambiguousIds = group.filter((g) => g.res.status === 'ambiguous').map((g) => g.record.id)
      const dismissed = group.some((g) => g.res.status === 'dismissed')
      if (ambiguousIds.length > 0 && !dismissed) {
        // Pass every ambiguous id on the line; the command resolves the one
        // the invoking user owns, so the lens never dead-ends on a teammate's.
        lenses.push(
          new vscode.CodeLens(range, {
            title,
            command: 'vouch.resolveAmbiguous',
            arguments: [ambiguousIds],
          }),
        )
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title,
            command: 'vouch.openTimeline',
            arguments: [group[0]!.record.id],
          }),
        )
      }

      // Re-review targets YOUR actionable record on this line, resolved by
      // the command itself — never a blind group[0], which could be a
      // teammate's file-level record with a different scope.
      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Re-review',
          command: 'vouch.reReview',
          arguments: [{ line }],
        }),
      )

      const anyReviewed = group.some((g) => g.res.status === 'reviewed')
      if (group[0]!.record.commit || anyReviewed) {
        // Single record: diff it directly. Multiple: let the user pick —
        // records in one group can belong to different authors and scopes.
        const diffCmd =
          group.length === 1
            ? { title: 'Diff', command: 'vouch.showDiff', arguments: [group[0]!.record.id] }
            : {
                title: 'Diff',
                command: 'vouch.pickDiff',
                arguments: [group.map((g) => g.record.id)],
              }
        lenses.push(new vscode.CodeLens(range, diffCmd))
      }
    }
    return lenses
  }
}
