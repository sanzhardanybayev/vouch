import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveRecord } from '../core/anchor'
import { fileCoverage, pct, type FileCoverage } from '../core/coverage'
import { isInsideRoot } from '../core/paths'
import { buildTree, headerStats, type TreeFile, type TreeFolder } from '../core/treemodel'
import type { VouchContext, RootEntry } from './context'
import type { StatusPipeline } from './pipeline'
import { lsFiles } from './gitinfo'

type Item =
  | { t: 'header' }
  | { t: 'folder'; root: RootEntry; node: TreeFolder }
  | { t: 'file'; root: RootEntry; file: TreeFile }
  | { t: 'orphanRoot' }
  | { t: 'orphan'; path: string }

export class CoverageTree implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  private covCache = new Map<string, { mtimeMs: number; gen: number; coverage: FileCoverage | null }>()
  private gen = 0
  private fileList = new Map<string, string[]>() // rootDir -> repo-relative paths
  private queue: { root: RootEntry; sourcePath: string }[] = []
  private queueRunning = false

  constructor(
    private readonly ctx: VouchContext,
    private readonly pipeline: StatusPipeline,
    subscriptions: vscode.Disposable[],
  ) {
    subscriptions.push(
      ctx.onDidChange(() => this.refresh()),
      pipeline.onDidUpdate(uri => this.onPipelineUpdate(uri)),
    )
    void this.loadFileLists().then(() => this.refresh())
  }

  private async loadFileLists(): Promise<void> {
    for (const root of this.ctx.roots) {
      const files = await lsFiles(root.rootDir)
      this.fileList.set(root.rootDir, files.length > 0 ? files : await this.findFallback(root))
    }
  }

  private async findFallback(root: RootEntry): Promise<string[]> {
    const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 20_000)
    return uris
      .filter(u => isInsideRoot(root.rootDir, u.fsPath))
      .map(u => path.relative(root.rootDir, u.fsPath).split(path.sep).join('/'))
  }

  refresh(): void {
    // Anything not refreshed by the pass we're about to start is left over
    // from an even older generation (e.g. a file that fell out of the
    // attested set, or a root that no longer exists) — drop it so covCache
    // doesn't grow unboundedly across refreshes.
    for (const [key, entry] of this.covCache) {
      if (entry.gen !== this.gen) this.covCache.delete(key)
    }
    this.gen++
    this.queue = this.ctx.roots.flatMap(root =>
      root.store.attestedFiles()
        .filter(p => fs.existsSync(path.join(root.rootDir, p)))
        .map(sourcePath => ({ root, sourcePath })))
    this.runQueue()
    this.emitter.fire(undefined)
  }

  // The pipeline recomputes status (from the live buffer) whenever an open
  // document changes, debounced. If that document is an attested file, jump
  // it to the front of the queue so the sidebar picks up the new coverage
  // promptly instead of waiting for the next full refresh().
  private onPipelineUpdate(uri: vscode.Uri): void {
    const root = this.ctx.rootFor(uri)
    const sourcePath = root ? this.ctx.sourcePathOf(uri) : null
    const state = root && sourcePath ? root.store.stateFor(sourcePath) : undefined
    if (root && sourcePath && state && state.current.length > 0) {
      this.queue.unshift({ root, sourcePath })
      this.runQueue()
    }
    this.emitter.fire(undefined)
  }

  private runQueue(): void {
    if (this.queueRunning) return
    this.queueRunning = true
    const tick = (): void => {
      const job = this.queue.shift()
      if (!job) { this.queueRunning = false; this.emitter.fire(undefined); return }
      void this.processJob(job).finally(() => setTimeout(tick, 25))
    }
    tick()
  }

  private async processJob(job: { root: RootEntry; sourcePath: string }): Promise<void> {
    const abs = path.join(job.root.rootDir, job.sourcePath)
    try {
      // An attested file open in an editor may have unsaved edits: the
      // gutter's live decorations are driven by the pipeline (buffer text
      // via statusFor), so route through the same call here instead of
      // re-reading disk — otherwise the sidebar % reflects last-saved
      // content and visibly disagrees with the gutter until save.
      const openDoc = vscode.workspace.textDocuments.find(
        d => d.uri.scheme === 'file' && d.uri.fsPath === abs)
      if (openDoc) {
        const status = await this.pipeline.statusFor(openDoc)
        // A live buffer has no disk mtime; -1 just needs to differ from any
        // real fs mtimeMs so a later disk read (once the doc closes) isn't
        // mistaken for "unchanged" and skipped.
        this.covCache.set(abs, { mtimeMs: -1, gen: this.gen, coverage: status.coverage })
        return
      }
      const stat = fs.statSync(abs)
      const hit = this.covCache.get(abs)
      if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.gen !== this.gen) {
        const text = fs.readFileSync(abs, 'utf8')
        const state = job.root.store.stateFor(job.sourcePath)!
        const entries = state.current.map(record => ({
          record, res: resolveRecord(record, text) })) // text-only (spec §8)
        this.covCache.set(abs, {
          mtimeMs: stat.mtimeMs, gen: this.gen, coverage: fileCoverage(entries, text) })
      }
    } catch {
      // Deleted after existsSync, EACCES, EISDIR, store race, etc. Write a
      // sentinel entry so the file renders as excluded (no %, dim) instead
      // of getting stuck on a permanent pending spinner from a missing
      // cache entry.
      this.covCache.set(abs, { mtimeMs: 0, gen: this.gen, coverage: null })
    }
  }

  private treeFiles(root: RootEntry): TreeFile[] {
    const attested = new Set(root.store.attestedFiles())
    const out: TreeFile[] = []
    for (const p of this.fileList.get(root.rootDir) ?? []) {
      if (!attested.has(p)) { out.push({ path: p, coverage: null }); continue }
      const cached = this.covCache.get(path.join(root.rootDir, p))
      out.push({ path: p, coverage: cached && cached.gen === this.gen ? cached.coverage : 'pending' })
    }
    return out
  }

  getTreeItem(el: Item): vscode.TreeItem {
    if (el.t === 'header') {
      const files = this.ctx.roots.flatMap(root => this.treeFiles(root))
      const totalFiles = files.length
      const counts = this.ctx.roots.reduce((acc, root) => {
        const c = root.store.counts()
        acc.records += c.records
        for (const [email, entry] of c.perAuthor) {
          const existing = acc.perAuthor.get(email)
          acc.perAuthor.set(email, existing
            ? { name: entry.name, current: existing.current + entry.current }
            : { name: entry.name, current: entry.current })
        }
        return acc
      }, { records: 0, perAuthor: new Map<string, { name: string; current: number }>() })
      const h = headerStats(files, totalFiles, counts)
      const item = new vscode.TreeItem('Coverage', vscode.TreeItemCollapsibleState.None)
      item.description = h.pending ? '…'
        : h.workspacePct === null ? 'no reviews yet'
        : `${h.workspacePct}% of attested · ${h.attested}/${h.totalFiles} files · ${h.records} reviews`
      item.iconPath = new vscode.ThemeIcon('shield')
      return item
    }
    if (el.t === 'folder') {
      const item = new vscode.TreeItem(el.node.name, vscode.TreeItemCollapsibleState.Collapsed)
      if (el.node.coverage === 'pending') item.description = '…'
      else if (el.node.coverage) item.description = `${pct(el.node.coverage)}%`
      item.iconPath = vscode.ThemeIcon.Folder
      return item
    }
    if (el.t === 'file') {
      const item = new vscode.TreeItem(path.basename(el.file.path), vscode.TreeItemCollapsibleState.None)
      const c = el.file.coverage
      if (c === 'pending') item.description = '…'
      else if (c) {
        const p = pct(c)
        item.description = `${p}%`
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(
          p === 100 ? 'charts.green' : p > 0 ? 'charts.yellow' : 'charts.red'))
      } else {
        item.iconPath = new vscode.ThemeIcon('circle-outline')
      }
      item.command = { command: 'vscode.open', title: 'Open',
        arguments: [vscode.Uri.file(path.join(el.root.rootDir, el.file.path))] }
      return item
    }
    if (el.t === 'orphanRoot') {
      const item = new vscode.TreeItem('Orphans', vscode.TreeItemCollapsibleState.Collapsed)
      item.iconPath = new vscode.ThemeIcon('warning')
      return item
    }
    const item = new vscode.TreeItem(el.path, vscode.TreeItemCollapsibleState.None)
    item.command = { command: 'vouch.reattach', title: 'Re-attach' }
    return item
  }

  getChildren(el?: Item): Item[] {
    if (!el) {
      const out: Item[] = [{ t: 'header' }]
      for (const root of this.ctx.roots) {
        const tree = buildTree(this.treeFiles(root))
        out.push(...tree.folders.map(node => ({ t: 'folder' as const, root, node })))
        out.push(...tree.files.map(file => ({ t: 'file' as const, root, file })))
      }
      const orphans = this.ctx.roots.flatMap(r =>
        r.store.orphans(p => fs.existsSync(path.join(r.rootDir, p))))
      if (orphans.length > 0) out.push({ t: 'orphanRoot' })
      return out
    }
    if (el.t === 'folder') {
      return [
        ...el.node.folders.map(node => ({ t: 'folder' as const, root: el.root, node })),
        ...el.node.files.map(file => ({ t: 'file' as const, root: el.root, file })),
      ]
    }
    if (el.t === 'orphanRoot') {
      return this.ctx.roots.flatMap(r =>
        r.store.orphans(p => fs.existsSync(path.join(r.rootDir, p)))
          .map(p => ({ t: 'orphan' as const, path: p })))
    }
    return []
  }
}
