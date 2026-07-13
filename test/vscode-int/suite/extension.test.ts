import * as assert from 'node:assert'
import * as vscode from 'vscode'

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
