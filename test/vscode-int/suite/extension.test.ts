import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fs from 'node:fs'

describe('activation', () => {
  it('activates and exposes the test api', async () => {
    const ext = vscode.extensions.getExtension('sanzhar.vouch')!
    assert.ok(ext, 'extension found')
    const api = await ext.activate()
    assert.ok(api.getTestApi().context, 'VouchContext created')
  })

  it('resolves root and source path for a file opened from the workspace folder', async () => {
    const ext = vscode.extensions.getExtension('sanzhar.vouch')!
    const api = await ext.activate()
    const folder = vscode.workspace.workspaceFolders![0]!
    const fileUri = vscode.Uri.joinPath(folder.uri, 'src', 'calc.ts')
    const doc = await vscode.workspace.openTextDocument(fileUri)
    const context = api.getTestApi().context
    assert.ok(context.rootFor(doc.uri), 'rootFor should resolve a root even through symlinked workspace paths')
    assert.strictEqual(context.sourcePathOf(doc.uri), 'src/calc.ts')
  })
})

describe('vouch.selection', () => {
  it('writes a record shard for the selected lines', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(0, 0, 2, 0) // lines 1-3
    await vscode.commands.executeCommand('vouch.init')
    // showInputBox for comment: stub by pre-resolving — instead run with typed command variant:
    // simplest reliable approach: temporarily monkeypatch showInputBox
    const orig = vscode.window.showInputBox
    ;(vscode.window as { showInputBox: typeof orig }).showInputBox = async () => ''
    try {
      await vscode.commands.executeCommand('vouch.selection')
    } finally {
      ;(vscode.window as { showInputBox: typeof orig }).showInputBox = orig
    }
    const reviewsDir = path.join(ws, '.vouch/reviews/src/calc.ts')
    const shards = fs.readdirSync(reviewsDir)
    assert.strictEqual(shards.length, 1)
    const line = fs.readFileSync(path.join(reviewsDir, shards[0]!), 'utf8').trim()
    const rec = JSON.parse(line)
    assert.strictEqual(rec.kind, 'selection')
    assert.deepStrictEqual(rec.range, [1, 3])
    assert.match(rec.hash, /^sha256:/)
    assert.strictEqual(rec.author.email, 'int@test.dev')
  })
})
