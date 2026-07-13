import * as vscode from 'vscode'
import { VouchContext } from './context'

let ctx: VouchContext | undefined

export async function activate(context: vscode.ExtensionContext): Promise<{
  getTestApi: () => { context: VouchContext }
}> {
  ctx = await VouchContext.create()
  context.subscriptions.push({ dispose: () => ctx?.dispose() })

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
