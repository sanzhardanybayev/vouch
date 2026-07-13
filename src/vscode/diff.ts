import * as vscode from 'vscode'
import { baselineSlice } from '../core/baseline'
import { isValidSha } from '../core/hovermd'
import { splitLines } from '../core/text'
import type { ReviewRecord } from '../core/types'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { showAtCommit } from './gitinfo'

const contents = new Map<string, string>()
let counter = 0

export class VouchBaselineProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'vouch-baseline'
  provideTextDocumentContent(uri: vscode.Uri): string {
    return contents.get(uri.path) ?? ''
  }
}

// Baseline/current text pairs accumulate one entry per showDiff call and are
// never explicitly released (there's no "close" hook for a diff tab), so the
// map would otherwise grow unbounded over a long editing session. Cap it: the
// map is insertion-ordered, so once it exceeds 50 entries, drop the oldest
// ones first — 50 entries is ~25 recent diffs (a baseline+current pair per
// showDiff), comfortably more than anyone needs to keep open at once.
const MAX_CONTENTS = 50

function register(text: string, label: string): vscode.Uri {
  const key = `/${counter++}/${label}`
  contents.set(key, text)
  while (contents.size > MAX_CONTENTS) {
    const oldest = contents.keys().next().value
    if (oldest === undefined) break
    contents.delete(oldest)
  }
  return vscode.Uri.from({ scheme: VouchBaselineProvider.scheme, path: key })
}

export function findRecord(
  ctx: VouchContext, recordId: string,
): { record: ReviewRecord; rootDir: string; sourcePath: string } | null {
  for (const root of ctx.roots) {
    for (const sourcePath of root.store.attestedFiles()) {
      const state = root.store.stateFor(sourcePath)!
      for (const members of state.chains.values()) {
        const record = members.find(m => m.id === recordId)
        if (record) return { record, rootDir: root.rootDir, sourcePath }
      }
    }
  }
  return null
}

export async function showDiff(
  ctx: VouchContext, pipeline: StatusPipeline, recordId: string,
): Promise<void> {
  const found = findRecord(ctx, recordId)
  if (!found) { void vscode.window.showWarningMessage('Vouch: record not found.'); return }
  const { record, rootDir, sourcePath } = found
  if (!record.commit || !isValidSha(record.commit)) {
    void vscode.window.showWarningMessage('Vouch: review has no commit (not a git repo at review time).')
    return
  }
  const committed = await showAtCommit(rootDir, record.commit, sourcePath)
  if (committed === null) {
    void vscode.window.showWarningMessage(`Vouch: commit ${record.commit.slice(0, 7)} not available locally.`)
    return
  }
  const sha7 = record.commit.slice(0, 7)
  const fileUri = vscode.Uri.file(`${rootDir}/${sourcePath}`)
  const base = baselineSlice(committed, record)

  if (base.verified && record.kind !== 'file') {
    const doc = await vscode.workspace.openTextDocument(fileUri)
    const status = await pipeline.statusFor(doc)
    const entry = status.entries.find(e => e.record.id === recordId)
    const range = entry?.res.effectiveRange ?? record.range ?? [1, 1]
    const currentSlice = splitLines(doc.getText()).slice(range[0] - 1, range[1]).join('\n')
    await vscode.commands.executeCommand('vscode.diff',
      register(base.text, `baseline-${sha7}`), register(currentSlice, 'current'),
      `Vouch: since ${sha7}`)
    return
  }

  if (!base.verified) {
    void vscode.window.showWarningMessage(
      `Vouch: reviewed text was not in commit ${sha7} — showing nearest baseline.`)
  }
  await vscode.commands.executeCommand('vscode.diff',
    register(committed, `baseline-${sha7}`), fileUri, `Vouch: since ${sha7} (whole file)`)
}
