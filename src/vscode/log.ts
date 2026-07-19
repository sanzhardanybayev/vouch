import * as vscode from 'vscode'

// A silent catch makes a persistent failure indistinguishable from
// "everything is fine" — every background refresh path logs here instead.
let channel: vscode.OutputChannel | undefined

export function initLog(subscriptions: vscode.Disposable[]): void {
  channel = vscode.window.createOutputChannel('Vouch')
  subscriptions.push(channel, { dispose: () => { channel = undefined } })
}

export function logError(scope: string, err: unknown): void {
  channel?.appendLine(`[${new Date().toISOString()}] ${scope}: ${String(err)}`)
}
