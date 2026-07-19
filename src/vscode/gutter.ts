import * as vscode from 'vscode'
import type { Status } from '../core/anchor'
import type { FileStatus } from './pipeline'

// Per-line precedence when records share an anchor line: a dismissed review
// needs action first, an unresolved ambiguity second, a green check last.
const RANK: Record<Status, number> = { dismissed: 2, ambiguous: 1, reviewed: 0 }

export class Gutter {
  private readonly decorations: Record<Status, vscode.TextEditorDecorationType>

  constructor(extensionUri: vscode.Uri) {
    const icon = (name: string): vscode.Uri =>
      vscode.Uri.joinPath(extensionUri, 'media', name)
    const mk = (svg: string, ruler: string): vscode.TextEditorDecorationType =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon(svg), gutterIconSize: 'contain',
        overviewRulerColor: ruler, overviewRulerLane: vscode.OverviewRulerLane.Right,
      })
    this.decorations = {
      reviewed: mk('reviewed.svg', '#1DBF9A'),
      dismissed: mk('dismissed.svg', '#FF7A2E'),
      ambiguous: mk('ambiguous.svg', '#E5B25E'),
    }
  }

  apply(editor: vscode.TextEditor, status: FileStatus): void {
    const byLine = new Map<number, Status>()
    for (const { res } of status.entries) {
      const line = res.effectiveRange[0]
      const prev = byLine.get(line)
      byLine.set(line, prev !== undefined && RANK[prev] >= RANK[res.status] ? prev : res.status)
    }
    for (const want of ['reviewed', 'dismissed', 'ambiguous'] as const) {
      const ranges = [...byLine.entries()].filter(([, s]) => s === want)
        .map(([l]) => new vscode.Range(l - 1, 0, l - 1, 0))
      editor.setDecorations(this.decorations[want], ranges)
    }
  }

  dispose(): void {
    for (const d of Object.values(this.decorations)) d.dispose()
  }
}
