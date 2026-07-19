import * as vscode from 'vscode'
import { VouchContext } from './context'
import { registerCommands } from './commands'
import { StatusPipeline } from './pipeline'
import { Gutter } from './gutter'
import { registerHovers } from './hovers'
import { VouchBaselineProvider } from './diff'
import { CoverageTree } from './sidebar'
import { VouchCodeLensProvider } from './codelens'
import { initLog, logError } from './log'

let ctx: VouchContext | undefined
// Reassigned below once the status pipeline is wired up; kept as a
// module-scope `let` so registerCommands can capture a stable closure that
// always calls the current implementation.
let refresh: () => void = () => {}

export async function activate(context: vscode.ExtensionContext): Promise<{
  getTestApi: () => { context: VouchContext; pipeline: StatusPipeline; coverageTree: CoverageTree }
}> {
  initLog(context.subscriptions)
  ctx = await VouchContext.create()
  context.subscriptions.push({ dispose: () => ctx?.dispose() })

  const pipeline = new StatusPipeline(ctx, context.subscriptions)
  registerCommands(context, ctx, () => refresh(), pipeline)
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
    VouchBaselineProvider.scheme, new VouchBaselineProvider()))

  // Watch each root's .vouch shards through a RelativePattern anchored at the
  // GIT ROOT, not a workspace-relative string glob: when the user opens a
  // subfolder of a repo, .vouch/ lives ABOVE the workspace folder and a
  // string glob would never fire — teammates' pulled reviews would sit
  // invisible until a window reload. Rebuilt whenever the root set changes.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleReload = (): void => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => { void ctx?.reload() }, 300)
  }
  let rootWatchers: vscode.Disposable[] = []
  const buildRootWatchers = (): void => {
    for (const w of rootWatchers) w.dispose()
    rootWatchers = (ctx?.roots ?? []).map(root => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(root.rootDir), '.vouch/reviews/**/*.jsonl'))
      watcher.onDidCreate(scheduleReload)
      watcher.onDidChange(scheduleReload)
      watcher.onDidDelete(scheduleReload)
      return watcher
    })
  }
  buildRootWatchers()
  context.subscriptions.push(
    { dispose: () => { for (const w of rootWatchers) w.dispose() } },
    { dispose: () => { if (reloadTimer) clearTimeout(reloadTimer) } },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void ctx?.rebuildRoots()
        .then(() => buildRootWatchers())
        .catch(e => logError('rebuildRoots', e))
    }))

  const gutter = new Gutter(context.extensionUri)
  context.subscriptions.push(gutter)
  registerHovers(context, ctx, pipeline)

  const applyTo = async (editor: vscode.TextEditor): Promise<void> => {
    gutter.apply(editor, await pipeline.statusFor(editor.document))
  }
  refresh = () => { pipeline.invalidate(); pipeline.refreshVisible() }
  context.subscriptions.push(
    pipeline.onDidUpdate(uri => {
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.toString() === uri.toString()) void applyTo(ed)
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(eds => { for (const e of eds) void applyTo(e) }))
  for (const e of vscode.window.visibleTextEditors) void applyTo(e)

  const tree = new CoverageTree(ctx, pipeline, context.subscriptions)
  context.subscriptions.push(vscode.window.registerTreeDataProvider('vouch.coverage', tree))

  // Damaged shards must be visible, not silently under-counted: warn once
  // whenever the corrupt-line total grows (merge-conflict leftovers, crashed
  // writes, hand edits). The persistent count lives in the header tooltip.
  let lastCorrupt = ctx.roots.reduce((n, r) => n + r.store.corruptLines, 0)
  context.subscriptions.push(ctx.onDidChange(() => {
    const corrupt = (ctx?.roots ?? []).reduce((n, r) => n + r.store.corruptLines, 0)
    if (corrupt > lastCorrupt) {
      void vscode.window.showWarningMessage(
        `Vouch: ${corrupt} unreadable line(s) in .vouch records - some reviews may not be counted. ` +
        'Check recent merges of .vouch/reviews/ files.')
    }
    lastCorrupt = corrupt
  }))

  context.subscriptions.push(vscode.commands.registerCommand('vouch.refresh', async () => {
    await ctx?.reload()
    await tree.reloadFileLists()
    refresh()
  }))

  const codeLensProvider = new VouchCodeLensProvider(pipeline, context.subscriptions)
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider))

  return { getTestApi: () => ({ context: ctx!, pipeline, coverageTree: tree }) }
}

export function deactivate(): void {}
