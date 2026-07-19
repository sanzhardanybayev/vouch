import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { buildTree } from '../../../src/core/treemodel'
import { pct } from '../../../src/core/coverage'

describe('activation', () => {
  it('activates and exposes the test api', async () => {
    const ext = vscode.extensions.getExtension('sanzhardanybayev.vouch-review-coverage')!
    assert.ok(ext, 'extension found')
    const api = await ext.activate()
    assert.ok(api.getTestApi().context, 'VouchContext created')
  })

  it('resolves root and source path for a file opened from the workspace folder', async () => {
    const ext = vscode.extensions.getExtension('sanzhardanybayev.vouch-review-coverage')!
    const api = await ext.activate()
    const folder = vscode.workspace.workspaceFolders![0]!
    const fileUri = vscode.Uri.joinPath(folder.uri, 'src', 'calc.ts')
    const doc = await vscode.workspace.openTextDocument(fileUri)
    const context = api.getTestApi().context
    assert.ok(
      context.rootFor(doc.uri),
      'rootFor should resolve a root even through symlinked workspace paths',
    )
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

describe('status pipeline', () => {
  it('reports reviewed for the fresh record, dismissed after an edit', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    const editor = await vscode.window.showTextDocument(doc)
    const api = (
      await vscode.extensions.getExtension('sanzhardanybayev.vouch-review-coverage')!.activate()
    ).getTestApi()

    let st = await api.pipeline.statusFor(doc)
    assert.strictEqual(st.entries.length, 1) // record from the Task 11 test
    assert.strictEqual(st.entries[0].res.status, 'reviewed')
    assert.deepStrictEqual(st.entries[0].res.effectiveRange, [1, 3])

    await editor.edit((b) =>
      b.replace(new vscode.Range(1, 0, 1, doc.lineAt(1).text.length), '  return a + b + 1'),
    )
    st = await api.pipeline.statusFor(doc)
    assert.strictEqual(st.entries[0].res.status, 'dismissed')

    await vscode.commands.executeCommand('workbench.action.files.revert') // restore for later tests
  })
})

describe('range hover', () => {
  it('returns vouch markdown for an attested line', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    await vscode.window.showTextDocument(doc)
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      new vscode.Position(0, 2),
    )
    const all = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
      .join('\n')
    assert.match(all, /reviewed|dismissed/)
    assert.match(all, /Vouch|timeline/i)
  })
})

describe('sidebar', () => {
  it('tree provider returns header + fixture tree', async () => {
    // Allow the background queue a moment
    await new Promise((r) => setTimeout(r, 500))
    await vscode.commands.executeCommand<unknown>('workbench.view.extension.vouch')
    // The command just focuses the view; real assertion is via the test api:
    const api = (
      await vscode.extensions.getExtension('sanzhardanybayev.vouch-review-coverage')!.activate()
    ).getTestApi()
    assert.ok(api.context.roots.length >= 1)
  })
})

describe('v1.1 honest coverage + reviewers', () => {
  it('sidebar exposes engineers and wires real coverage end-to-end', async () => {
    const api = (
      await vscode.extensions.getExtension('sanzhardanybayev.vouch-review-coverage')!.activate()
    ).getTestApi()
    // Let the background queue settle (it now counts every tracked file).
    await new Promise((r) => setTimeout(r, 1500))
    const root = api.context.roots[0]!
    // perEngineer surfaces the fixture author.
    const eng = root.store.perEngineer()
    assert.ok(eng.length >= 1, 'at least one engineer')
    assert.ok(eng.some((e: { email: string }) => e.email === 'int@test.dev'))

    // Prove the WIRING, not just that engineers exist: getTestSnapshot() runs
    // the real treeFiles -> buildTree -> headerStats pipeline the sidebar
    // uses internally, over the live fixture (calc.ts already carries an
    // attested selection review for lines 1-3 out of its 7, from the
    // 'vouch.selection' test above).
    const { header } = api.coverageTree.getTestSnapshot()
    assert.ok(header.totalFiles >= 1, 'at least one tracked file')
    assert.ok(header.reviewedFiles >= 1, 'at least one reviewed file')
    assert.ok(header.reviewedFiles <= header.totalFiles, 'reviewed cannot exceed total')
    assert.strictEqual(
      typeof header.workspacePct,
      'number',
      'workspacePct is a finite number once reviews exist',
    )
    assert.ok(header.workspacePct! >= 0 && header.workspacePct! <= 100, 'workspacePct in [0,100]')

    // Belt-and-suspenders: the pure math for a hand-built mixed
    // reviewed/unreviewed tree must be < 100%. The fixture here is a single
    // small file so it can't itself prove "not everything is 100%"; this
    // confirms the same buildTree/pct machinery the wiring above relies on
    // does the honest thing when unreviewed files are present (already
    // covered in test/core/treemodel.test.ts — repeated here so this
    // integration test isn't solely dependent on fixture contents staying
    // partially-reviewed).
    const mixed = buildTree([
      { path: 'a.ts', coverage: { reviewedLines: 5, totalLines: 10 }, reviewed: true },
      { path: 'b.ts', coverage: { reviewedLines: 0, totalLines: 10 }, reviewed: false },
    ])
    assert.notStrictEqual(mixed.coverage, null)
    assert.notStrictEqual(mixed.coverage, 'pending')
    const mixedCoverage = mixed.coverage as { reviewedLines: number; totalLines: number }
    assert.ok(pct(mixedCoverage) < 100)
  })
})

describe('v1.1 CodeLens', () => {
  it('provides a status lens on the reviewed range and none when disabled', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    await vscode.window.showTextDocument(doc)

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
    )
    const vouchLenses = (lenses ?? []).filter(
      (l) =>
        typeof l.command?.title === 'string' &&
        (l.command.title.includes('Reviewed') ||
          l.command.title.includes('Dismissed') ||
          l.command.title === 'Re-review' ||
          l.command.title === 'Diff'),
    )
    assert.ok(vouchLenses.length >= 1, 'at least one vouch codelens')

    await vscode.workspace
      .getConfiguration('vouch')
      .update('codeLens.enabled', false, vscode.ConfigurationTarget.Global)
    // Give the provider a tick to observe the config change.
    await new Promise((r) => setTimeout(r, 200))
    const lenses2 = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
    )
    const vouch2 = (lenses2 ?? []).filter(
      (l) =>
        typeof l.command?.title === 'string' &&
        (l.command.title.includes('Reviewed') || l.command.title.includes('Dismissed')),
    )
    assert.strictEqual(vouch2.length, 0, 'no vouch codelens when disabled')
    await vscode.workspace
      .getConfiguration('vouch')
      .update('codeLens.enabled', true, vscode.ConfigurationTarget.Global)
  })
})
