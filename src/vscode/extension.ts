import * as vscode from 'vscode'
import { VouchContext } from './context'
import { registerCommands } from './commands'

let ctx: VouchContext | undefined
// no-op until Task 12 wires decorations; kept as a module-scope `let` so
// registerCommands can capture a stable closure that always calls the
// current implementation.
let refresh: () => void = () => {}

export async function activate(context: vscode.ExtensionContext): Promise<{
  getTestApi: () => { context: VouchContext }
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

  return { getTestApi: () => ({ context: ctx! }) }
}

export function deactivate(): void {}
