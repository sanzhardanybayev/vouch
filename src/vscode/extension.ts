import * as vscode from 'vscode'
import { VouchContext } from './context'
import { registerCommands } from './commands'
import { StatusPipeline } from './pipeline'
import { Gutter } from './gutter'
import { registerHovers } from './hovers'
import { VouchBaselineProvider } from './diff'
import { CoverageTree } from './sidebar'
import { VouchCodeLensProvider } from './codelens'

let ctx: VouchContext | undefined
// Reassigned below once the status pipeline is wired up; kept as a
// module-scope `let` so registerCommands can capture a stable closure that
// always calls the current implementation.
let refresh: () => void = () => {}

export async function activate(context: vscode.ExtensionContext): Promise<{
  getTestApi: () => { context: VouchContext; pipeline: StatusPipeline }
}> {
  ctx = await VouchContext.create()
  context.subscriptions.push({ dispose: () => ctx?.dispose() })

  const pipeline = new StatusPipeline(ctx, context.subscriptions)
  registerCommands(context, ctx, () => refresh(), pipeline)
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
    VouchBaselineProvider.scheme, new VouchBaselineProvider()))

  const watcher = vscode.workspace.createFileSystemWatcher('**/.vouch/reviews/**/*.jsonl')
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void ctx?.reload() }, 300)
  }
  watcher.onDidCreate(scheduleReload)
  watcher.onDidChange(scheduleReload)
  watcher.onDidDelete(scheduleReload)
  context.subscriptions.push(watcher)
  context.subscriptions.push({ dispose: () => { if (timer) clearTimeout(timer) } })

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

  const codeLensProvider = new VouchCodeLensProvider(pipeline, context.subscriptions)
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider))

  return { getTestApi: () => ({ context: ctx!, pipeline }) }
}

export function deactivate(): void {}
