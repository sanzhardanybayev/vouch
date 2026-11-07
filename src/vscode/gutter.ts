import * as vscode from 'vscode'
import type { Status } from '../core/anchor'
import { lineStatuses } from '../core/bars'
import type { FileStatus } from './pipeline'

// Per-line precedence when records share an anchor line: a dismissed review
// needs action first, an unresolved ambiguity second, a green check last.
const RANK: Record<Status, number> = { dismissed: 2, ambiguous: 1, reviewed: 0 }
const STATUSES = ['reviewed', 'dismissed', 'ambiguous'] as const

export type DecorationStyle = 'bars' | 'gutterIcons'

export function decorationStyle(): DecorationStyle {
  const v = vscode.workspace
    .getConfiguration('vouch')
    .get<string>('decorations.style', 'gutterIcons')
  return v === 'bars' ? 'bars' : 'gutterIcons'
}

/**
 * Two renderings of the same per-file statuses, both in the glyph margin -
 * the only gutter column the extension API can draw in (the lines-decorations
 * column beside the SCM change bars is reserved to VS Code itself):
 * - 'bars': a thin bar on every line of the reviewed span, at the right edge
 *   of the glyph margin next to the line numbers, so the span is visible and
 *   a breakpoint dot on the same line is not covered.
 * - 'gutterIcons' (deprecated, default until the next major version): one
 *   icon filling the glyph cell on the first line of each review; shows no
 *   span, and an icon and a breakpoint on the same line cover each other.
 */
export class Gutter {
  private readonly icons: Record<Status, vscode.TextEditorDecorationType>
  private readonly bars: Record<Status, vscode.TextEditorDecorationType>

  constructor(extensionUri: vscode.Uri) {
    const icon = (name: string): vscode.Uri => vscode.Uri.joinPath(extensionUri, 'media', name)
    const mkIcon = (svg: string, ruler: string): vscode.TextEditorDecorationType =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon(svg),
        gutterIconSize: 'contain',
        overviewRulerColor: ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      })
    this.icons = {
      reviewed: mkIcon('reviewed.svg', '#1DBF9A'),
      dismissed: mkIcon('dismissed.svg', '#FF7A2E'),
      ambiguous: mkIcon('ambiguous.svg', '#E5B25E'),
    }
    // One bar per line; the SVG stretches to the full cell height so the
    // lines join into a continuous bar.
    const mkBar = (svg: string, ruler: string): vscode.TextEditorDecorationType =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon(svg),
        gutterIconSize: '100% 100%',
        overviewRulerColor: ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      })
    this.bars = {
      reviewed: mkBar('bar-reviewed.svg', '#1DBF9A'),
      dismissed: mkBar('bar-dismissed.svg', '#FF7A2E'),
      ambiguous: mkBar('bar-ambiguous.svg', '#E5B25E'),
    }
  }

  apply(editor: vscode.TextEditor, status: FileStatus): void {
    if (decorationStyle() === 'bars') {
      this.clear(editor, this.icons)
      this.applyBars(editor, status)
    } else {
      this.clear(editor, this.bars)
      this.applyIcons(editor, status)
    }
  }

  private applyBars(editor: vscode.TextEditor, status: FileStatus): void {
    const spans = lineStatuses(
      status.entries.map((e) => ({ status: e.res.status, range: e.res.effectiveRange })),
      editor.document.lineCount,
    )
    for (const want of STATUSES) {
      const ranges = spans
        .filter((s) => s.status === want)
        .flatMap((s) => {
          // One single-line range per line, so the bar never depends on
          // how a multi-line range's gutter icon is laid out.
          const lines: vscode.Range[] = []
          for (let l = s.range[0]; l <= s.range[1]; l++)
            lines.push(new vscode.Range(l - 1, 0, l - 1, 0))
          return lines
        })
      editor.setDecorations(this.bars[want], ranges)
    }
  }

  private applyIcons(editor: vscode.TextEditor, status: FileStatus): void {
    const byLine = new Map<number, Status>()
    for (const { res } of status.entries) {
      const line = res.effectiveRange[0]
      const prev = byLine.get(line)
      byLine.set(line, prev !== undefined && RANK[prev] >= RANK[res.status] ? prev : res.status)
    }
    for (const want of STATUSES) {
      const ranges = [...byLine.entries()]
        .filter(([, s]) => s === want)
        .map(([l]) => new vscode.Range(l - 1, 0, l - 1, 0))
      editor.setDecorations(this.icons[want], ranges)
    }
  }

  private clear(
    editor: vscode.TextEditor,
    set: Record<Status, vscode.TextEditorDecorationType>,
  ): void {
    for (const d of Object.values(set)) editor.setDecorations(d, [])
  }

  dispose(): void {
    for (const d of [...Object.values(this.icons), ...Object.values(this.bars)]) d.dispose()
  }
}
