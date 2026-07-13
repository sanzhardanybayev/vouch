import * as vscode from 'vscode'
import { VouchContext } from './context'
import { registerCommands } from './commands'
import { StatusPipeline } from './pipeline'
import { Gutter } from './gutter'

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

  registerCommands(context, ctx, () => refresh())

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

  const pipeline = new StatusPipeline(ctx, context.subscriptions)
  const gutter = new Gutter(context.extensionUri)
  context.subscriptions.push(gutter)

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

  return { getTestApi: () => ({ context: ctx!, pipeline }) }
}

export function deactivate(): void {}
