import * as vscode from 'vscode'
import type { FileStatus } from './pipeline'

export class Gutter {
  private readonly reviewed: vscode.TextEditorDecorationType
  private readonly dismissed: vscode.TextEditorDecorationType

  constructor(extensionUri: vscode.Uri) {
    const icon = (name: string): vscode.Uri =>
      vscode.Uri.joinPath(extensionUri, 'media', name)
    this.reviewed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('reviewed.svg'), gutterIconSize: 'contain',
      overviewRulerColor: '#2ea043', overviewRulerLane: vscode.OverviewRulerLane.Right,
    })
    this.dismissed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('dismissed.svg'), gutterIconSize: 'contain',
      overviewRulerColor: '#d29922', overviewRulerLane: vscode.OverviewRulerLane.Right,
    })
  }

  apply(editor: vscode.TextEditor, status: FileStatus): void {
    const byLine = new Map<number, 'reviewed' | 'dismissed'>()
    for (const { res } of status.entries) {
      const line = res.effectiveRange[0]
      const prev = byLine.get(line)
      byLine.set(line, prev === 'dismissed' ? 'dismissed' : res.status) // dismissed wins
    }
    const ranges = (want: 'reviewed' | 'dismissed'): vscode.Range[] =>
      [...byLine.entries()].filter(([, s]) => s === want)
        .map(([l]) => new vscode.Range(l - 1, 0, l - 1, 0))
    editor.setDecorations(this.reviewed, ranges('reviewed'))
    editor.setDecorations(this.dismissed, ranges('dismissed'))
  }

  dispose(): void {
    this.reviewed.dispose()
    this.dismissed.dispose()
  }
}
