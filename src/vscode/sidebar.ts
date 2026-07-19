import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildLineIndex, resolveRecord } from '../core/anchor'
import { fileCoverage, pct, type FileCoverage } from '../core/coverage'
import { textFileCoverage } from '../core/linecount'
import { isInsideRoot } from '../core/paths'
import { buildTree, headerStats, type HeaderStats, type TreeFile, type TreeFolder } from '../core/treemodel'
import { aggregateEngineers } from '../core/engineers'
import { shouldRequeue } from '../core/requeue'
import { compileVouchIgnore, type VouchIgnore } from '../core/vouchignore'
import { isKnownKind } from '../core/records'
import type { VouchContext, RootEntry } from './context'
import type { StatusPipeline } from './pipeline'
import { lsFiles } from './gitinfo'
import { logError } from './log'

const MAX_FILES = 20_000

type CacheEntry = { mtimeMs: number; coverage: FileCoverage | null; reviewed: boolean }

type Item =
  | { t: 'header' }
  | { t: 'reviewersRoot' }
  | { t: 'engineer'; email: string }
  | { t: 'engineerFile'; root: RootEntry; sourcePath: string; count: number }
  | { t: 'folder'; root: RootEntry; node: TreeFolder }
  | { t: 'file'; root: RootEntry; file: TreeFile }
  | { t: 'welcome'; root: RootEntry }
  | { t: 'orphanRoot' }
  | { t: 'orphan'; path: string }

export class CoverageTree implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  private covCache = new Map<string, CacheEntry>()
  private fileList = new Map<string, string[]>() // rootDir -> repo-relative paths
  private ignores = new Map<string, VouchIgnore>() // rootDir -> .vouchignore matcher
  private truncated = new Set<string>() // rootDirs whose tracked list hit MAX_FILES
  private queue: { root: RootEntry; sourcePath: string }[] = []
  private queueRunning = false
  private fsWatchTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly ctx: VouchContext,
    private readonly pipeline: StatusPipeline,
    subscriptions: vscode.Disposable[],
  ) {
    subscriptions.push(
      ctx.onDidChange(() => { void this.onCtxChange() }),
      pipeline.onDidUpdate(uri => this.onPipelineUpdate(uri)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vouch.coverage.enabled')) {
          void this.reloadFileLists().catch(err => logError('sidebar.configChange', err))
        }
      }),
    )
    // Files created or deleted after activation must be reflected in the
    // tracked-file list — otherwise a deleted file becomes a permanent
    // 'pending' ghost (never removed from fileList) and a new file is never
    // counted at all. Content edits (onDidChange) don't affect membership,
    // so we deliberately don't watch those here; the pipeline/attest flow
    // already covers content changes.
    const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*')
    const scheduleFileListReload = (): void => {
      if (this.fsWatchTimer) clearTimeout(this.fsWatchTimer)
      this.fsWatchTimer = setTimeout(() => {
        void this.reloadFileLists().catch(err => logError('sidebar.fsWatch', err))
      }, 300)
    }
    fsWatcher.onDidCreate(scheduleFileListReload)
    fsWatcher.onDidDelete(scheduleFileListReload)
    subscriptions.push(fsWatcher, { dispose: () => { if (this.fsWatchTimer) clearTimeout(this.fsWatchTimer) } })
    // .vouchignore's CONTENT is membership, so unlike source files its edits
    // must reload. A per-root RelativePattern anchored at rootDir also fires
    // when .vouch/.vouchignore live ABOVE a subfolder workspace, where the
    // '**/*' watcher sees nothing.
    this.buildIgnoreWatchers(scheduleFileListReload)
    subscriptions.push(
      ctx.onDidChange(() => this.buildIgnoreWatchers(scheduleFileListReload)),
      { dispose: () => { for (const w of this.ignoreWatchers) w.dispose() } },
    )
    void this.reloadFileLists().catch(err => logError('sidebar.initialLoad', err))
  }

  private ignoreWatchers: vscode.Disposable[] = []
  private buildIgnoreWatchers(onChange: () => void): void {
    for (const w of this.ignoreWatchers) w.dispose()
    this.ignoreWatchers = this.ctx.roots.map(root => {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root.rootDir), '.vouchignore'))
      w.onDidCreate(onChange); w.onDidChange(onChange); w.onDidDelete(onChange)
      return w
    })
  }

  private coverageEnabled(): boolean {
    return vscode.workspace.getConfiguration('vouch').get<boolean>('coverage.enabled', true)
  }

  // A root joins the coverage scan only once it actually uses Vouch. Every
  // other repo the user opens must not pay a full-tree read on activation.
  private rootLive(root: RootEntry): boolean {
    return this.coverageEnabled() && fs.existsSync(path.join(root.rootDir, '.vouch'))
  }

  // Store changes can also flip a root live (vouch.init ran, a pull created
  // .vouch/ above the workspace folder): give such roots a tracked-file list
  // before repainting, otherwise the welcome node would sit there until the
  // next window reload.
  private async onCtxChange(): Promise<void> {
    // Symmetric staleness: liveness and fileList presence must agree in BOTH
    // directions. not-live -> live (init/pull created .vouch/) needs a scan;
    // live -> not-live (.vouch/ removed) must drop the stale list so the
    // header stops counting a dead root. Plus roots that left the workspace.
    const stale = this.ctx.roots.some(r => this.rootLive(r) !== this.fileList.has(r.rootDir)) ||
      [...this.fileList.keys()].some(dir => !this.ctx.roots.some(r => r.rootDir === dir))
    if (stale) {
      await this.loadFileLists().catch(err => logError('sidebar.onCtxChange', err))
    }
    this.refresh()
  }

  async reloadFileLists(): Promise<void> {
    await this.loadFileLists()
    this.refresh()
  }

  private async loadFileLists(): Promise<void> {
    for (const dir of [...this.fileList.keys()]) {
      if (!this.ctx.roots.some(r => r.rootDir === dir)) {
        this.fileList.delete(dir)
        this.truncated.delete(dir) // a removed root must not leave a stuck "(partial)"
      }
    }
    for (const root of this.ctx.roots) {
      this.ignores.set(root.rootDir, this.loadIgnore(root))
      if (!this.rootLive(root)) {
        this.fileList.delete(root.rootDir)
        this.truncated.delete(root.rootDir)
        continue
      }
      const gitFiles = await lsFiles(root.rootDir)
      const { list, truncated: fallbackTruncated } = gitFiles.length > 0
        ? { list: gitFiles, truncated: false } : await this.findFallback(root)
      // Apply .vouchignore BEFORE the cap so the coverage UNIVERSE is the
      // post-filter set: ignored files must not consume slots and push real
      // files past the cap, and narrowing the universe below the cap must
      // actually clear "(partial)".
      const ig = this.ignores.get(root.rootDir)!
      const kept = list.filter(p => !ig.ignores(p))
      if (kept.length > MAX_FILES || fallbackTruncated) {
        this.truncated.add(root.rootDir)
        logError('sidebar.loadFileLists',
          `${kept.length}${fallbackTruncated ? '+' : ''} files in ${root.rootDir}; ` +
          `coverage capped at ${MAX_FILES} (header shows "partial")`)
      } else {
        this.truncated.delete(root.rootDir)
      }
      this.fileList.set(root.rootDir, kept.slice(0, MAX_FILES))
    }
  }

  private loadIgnore(root: RootEntry): VouchIgnore {
    try {
      return compileVouchIgnore(fs.readFileSync(path.join(root.rootDir, '.vouchignore'), 'utf8'))
    } catch (err) {
      // Absent is the normal case (silent); an unreadable-but-present
      // .vouchignore (EACCES, EISDIR) would silently balloon the universe, so
      // surface it. Fallback stays include-all either way.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') logError('sidebar.loadIgnore', err)
      return compileVouchIgnore('')
    }
  }

  // Scopes store-derived aggregates (header counts, reviewers, orphans) to
  // the same universe the tree shows.
  private includeFor(root: RootEntry): (p: string) => boolean {
    const ig = this.ignores.get(root.rootDir)
    return ig ? (p): boolean => !ig.ignores(p) : (): boolean => true
  }

  private async findFallback(root: RootEntry): Promise<{ list: string[]; truncated: boolean }> {
    // Query one past the cap so hitting it is detectable and can be surfaced
    // as "(partial)" rather than silently presenting an incomplete denominator
    // as the whole truth. The cap is workspace-wide, so any fallback root may
    // be missing files once it's hit.
    const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', MAX_FILES + 1)
    const list = uris
      .filter(u => isInsideRoot(root.rootDir, u.fsPath))
      .map(u => path.relative(root.rootDir, u.fsPath).split(path.sep).join('/'))
    return { list, truncated: uris.length > MAX_FILES }
  }

  refresh(): void {
    // Cache validity is presence+mtime based (see CacheEntry/treeFiles), not
    // generation based — so a refresh() must NOT mass-invalidate. It only
    // needs to (a) prune entries that fell out of the tracked-file set (a
    // deleted file, or a root that no longer exists) so covCache doesn't grow
    // unboundedly, and (b) requeue the small set of files that actually need
    // recomputing.
    const validAbs = new Set(this.ctx.roots.flatMap(root =>
      (this.fileList.get(root.rootDir) ?? []).map(p => path.join(root.rootDir, p))))
    for (const key of this.covCache.keys()) {
      if (!validAbs.has(key)) this.covCache.delete(key)
    }
    // Requeue: attested files (the record set may have changed — an
    // attest/dismiss/revoke — even when the file's own text didn't, so these
    // always need a recompute), files with no cache entry yet (never
    // counted), and files cached as reviewed (a file's *last* active review
    // being dismissed/revoked flips it attested -> unattested by touching
    // only `.vouch/reviews/*.jsonl`, never the source file's mtime — so a
    // stale reviewed:true entry must be re-evaluated even though neither the
    // "attested" nor the "no cache entry" condition catches it on their
    // own). See core/requeue.ts for the pure decision. Already-counted,
    // unreviewed, unattested files are the only ones left cached — this is
    // what keeps a single attest/dismiss from requeuing the whole tree.
    this.queue = this.ctx.roots.flatMap(root =>
      (this.fileList.get(root.rootDir) ?? [])
        .filter(p => fs.existsSync(path.join(root.rootDir, p)))
        .filter(p => shouldRequeue(this.isAttested(root, p), this.covCache.get(path.join(root.rootDir, p))))
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
    if (root && sourcePath) {
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

  private isAttested(root: RootEntry, sourcePath: string): boolean {
    const state = root.store.stateFor(sourcePath)
    return !!state && state.current.length > 0
  }

  private async processJob(job: { root: RootEntry; sourcePath: string }): Promise<void> {
    const abs = path.join(job.root.rootDir, job.sourcePath)
    try {
      const attested = this.isAttested(job.root, job.sourcePath)
      if (attested) {
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
          this.covCache.set(abs, { mtimeMs: -1, coverage: status.coverage, reviewed: true })
          return
        }
        // Always recompute for attested files — never mtime-skip. The
        // attested record set can change (attest/dismiss/revoke) even when
        // the file's own text and mtime didn't, so a cache hit here would
        // silently serve a stale coverage after a review action.
        const stat = fs.statSync(abs)
        const text = fs.readFileSync(abs, 'utf8')
        const state = job.root.store.stateFor(job.sourcePath)!
        // Text-only path (spec §8): no symbol provider here, so resolution
        // takes the conservative rule; the shared index keeps the scan
        // linear across all of the file's records.
        const index = buildLineIndex(text)
        const entries = state.current.filter(isKnownKind).map(record => ({
          record, res: resolveRecord(record, text, null, index) }))
        this.covCache.set(abs, {
          mtimeMs: stat.mtimeMs, coverage: fileCoverage(entries, text), reviewed: true })
        return
      }
      // Unreviewed file: line-count only, and only if it hasn't been counted
      // yet, the file changed on disk since, or the cached entry still
      // claims reviewed:true. That last condition matters here too, not just
      // in refresh()'s requeue filter: a file can reach this branch via
      // onPipelineUpdate (which bypasses the requeue filter entirely) or
      // simply race a stale entry into the queue, and dismissing/revoking a
      // file's last review never touches the source file's mtime — so
      // without this, a stale reviewed:true entry would survive the
      // mtime-guard forever instead of recomputing to unreviewed {0, N}.
      const stat = fs.statSync(abs)
      const hit = this.covCache.get(abs)
      if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.reviewed) {
        const coverage = countFileCoverage(abs)
        this.covCache.set(abs, { mtimeMs: stat.mtimeMs, coverage, reviewed: false })
      }
    } catch {
      // Deleted after existsSync, EACCES, EISDIR, store race, etc. Write a
      // sentinel entry so the file renders as excluded (no %, dim) instead
      // of getting stuck on a permanent pending spinner from a missing
      // cache entry.
      this.covCache.set(abs, { mtimeMs: 0, coverage: null, reviewed: false })
    }
  }

  private treeFiles(root: RootEntry): TreeFile[] {
    const out: TreeFile[] = []
    for (const p of this.fileList.get(root.rootDir) ?? []) {
      const cached = this.covCache.get(path.join(root.rootDir, p))
      if (!cached) { out.push({ path: p, coverage: 'pending', reviewed: false }); continue }
      out.push({ path: p, coverage: cached.coverage, reviewed: cached.reviewed })
    }
    return out
  }

  // Test-only escape hatch: expose the same treeFiles -> buildTree ->
  // headerStats pipeline getTreeItem/getChildren use internally, so an
  // integration test can assert real coverage facts about the live tree
  // instead of only reaching in through vscode UI commands.
  getTestSnapshot(): { header: HeaderStats; roots: { rootDir: string; tree: TreeFolder }[] } {
    return {
      header: this.computeHeaderStats(),
      roots: this.ctx.roots.map(root => ({ rootDir: root.rootDir, tree: buildTree(this.treeFiles(root)) })),
    }
  }

  private computeHeaderStats(): HeaderStats {
    const files = this.ctx.roots.flatMap(root => this.treeFiles(root))
    const counts = this.ctx.roots.reduce((acc, root) => {
      const c = root.store.counts(this.includeFor(root))
      acc.records += c.records
      for (const [email, entry] of c.perAuthor) {
        const ex = acc.perAuthor.get(email)
        acc.perAuthor.set(email, ex
          ? { name: entry.name, current: ex.current + entry.current }
          : { name: entry.name, current: entry.current })
      }
      return acc
    }, { records: 0, perAuthor: new Map<string, { name: string; current: number }>() })
    return headerStats(files, files.length, counts)
  }

  getTreeItem(el: Item): vscode.TreeItem {
    if (el.t === 'header') {
      const h = this.computeHeaderStats()
      const item = new vscode.TreeItem('Coverage', vscode.TreeItemCollapsibleState.None)
      const partial = this.truncated.size > 0 ? ' (partial)' : ''
      item.description = !this.coverageEnabled() ? 'coverage disabled'
        : h.pending ? '…'
        : h.workspacePct === null ? 'no reviews yet'
        : `${h.workspacePct}% · ${h.reviewedFiles}/${h.totalFiles} files · ${h.records} reviews${partial}`
      const notes: string[] = []
      if (!this.coverageEnabled()) {
        notes.push('File scanning is off (vouch.coverage.enabled). Reviewers and orphans still shown.')
      }
      if (this.truncated.size > 0) {
        notes.push(`Partial: more than ${MAX_FILES.toLocaleString()} tracked files - ` +
          'coverage covers only the first slice. Use .vouchignore to narrow the universe.')
      }
      const corrupt = this.ctx.roots.reduce((n, r) => n + r.store.corruptLines, 0)
      if (corrupt > 0) {
        notes.push(`${corrupt} unreadable line(s) in .vouch records - some reviews may be missing.`)
      }
      if (notes.length > 0) item.tooltip = notes.join('\n')
      item.iconPath = new vscode.ThemeIcon('shield')
      return item
    }
    if (el.t === 'welcome') {
      const item = new vscode.TreeItem(
        'Initialize Vouch to track coverage here', vscode.TreeItemCollapsibleState.None)
      item.description = path.basename(el.root.rootDir)
      item.iconPath = new vscode.ThemeIcon('rocket')
      item.command = { command: 'vouch.init', title: 'Initialize' }
      return item
    }
    if (el.t === 'reviewersRoot') {
      const item = new vscode.TreeItem('Reviewers', vscode.TreeItemCollapsibleState.Expanded)
      item.iconPath = new vscode.ThemeIcon('account')
      return item
    }
    if (el.t === 'engineer') {
      const eng = this.engineers().find(e => e.email === el.email)
      const item = new vscode.TreeItem(eng?.name ?? el.email, vscode.TreeItemCollapsibleState.Collapsed)
      item.description = eng ? `${eng.reviewCount} reviews · ${eng.files.length} files` : ''
      item.iconPath = new vscode.ThemeIcon('person')
      return item
    }
    if (el.t === 'engineerFile') {
      const item = new vscode.TreeItem(path.basename(el.sourcePath), vscode.TreeItemCollapsibleState.None)
      item.description = `${el.count}`
      item.resourceUri = vscode.Uri.file(path.join(el.root.rootDir, el.sourcePath))
      item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] }
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
      if (el.file.reviewed && c && c !== 'pending') {
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

  private engineers(): ReturnType<typeof aggregateEngineers<RootEntry>> {
    // Aggregate across roots by email; each file entry carries the root it
    // came from (see core/engineers.ts) so getChildren can open the correct
    // root's file directly, instead of guessing it back afterwards.
    return aggregateEngineers(this.ctx.roots, root => root.store.perEngineer(this.includeFor(root)))
  }

  getChildren(el?: Item): Item[] {
    if (!el) {
      const out: Item[] = [{ t: 'header' }]
      if (this.engineers().length > 0) out.push({ t: 'reviewersRoot' })
      if (this.coverageEnabled()) {
        for (const root of this.ctx.roots) {
          if (!this.rootLive(root)) { out.push({ t: 'welcome', root }); continue }
          const tree = buildTree(this.treeFiles(root))
          out.push(...tree.folders.map(node => ({ t: 'folder' as const, root, node })))
          out.push(...tree.files.map(file => ({ t: 'file' as const, root, file })))
        }
      }
      const orphans = this.ctx.roots.flatMap(r =>
        r.store.orphans(p => fs.existsSync(path.join(r.rootDir, p)), this.includeFor(r)))
      if (orphans.length > 0) out.push({ t: 'orphanRoot' })
      return out
    }
    if (el.t === 'reviewersRoot') {
      return this.engineers().map(e => ({ t: 'engineer' as const, email: e.email }))
    }
    if (el.t === 'engineer') {
      const eng = this.engineers().find(e => e.email === el.email)
      if (!eng) return []
      // Each file entry already carries the root it came from (aggregateEngineers),
      // so no need to guess it back — a same-named file in two roots yields two
      // distinct rows here, each opening its own root's copy.
      return eng.files.map(f => ({ t: 'engineerFile' as const, root: f.root, sourcePath: f.sourcePath, count: f.count }))
    }
    if (el.t === 'folder') {
      return [
        ...el.node.folders.map(node => ({ t: 'folder' as const, root: el.root, node })),
        ...el.node.files.map(file => ({ t: 'file' as const, root: el.root, file })),
      ]
    }
    if (el.t === 'orphanRoot') {
      return this.ctx.roots.flatMap(r =>
        r.store.orphans(p => fs.existsSync(path.join(r.rootDir, p)), this.includeFor(r))
          .map(p => ({ t: 'orphan' as const, path: p })))
    }
    return []
  }
}

// Line-count a file for the coverage denominator. Returns {0, N} for a text
// file with N lines, or null for binary/empty/unreadable (excluded from
// coverage entirely, never counted as 0-reviewed).
//
// Reads only the first 8192 bytes to check for a NUL byte first — a binary
// file (image, archive, etc.) is rejected on that prefix alone, so we never
// buffer the rest of a large binary just to throw it away. Only once the
// prefix is clean do we read the whole file (still required to count lines
// for a large text file); the actual binary/empty/line-count decision is
// delegated to the pure textFileCoverage so it stays unit-testable without fs.
function countFileCoverage(abs: string): FileCoverage | null {
  try {
    const fd = fs.openSync(abs, 'r')
    try {
      const prefix = Buffer.alloc(8192)
      const bytesRead = fs.readSync(fd, prefix, 0, prefix.length, 0)
      if (prefix.subarray(0, bytesRead).includes(0)) return null // NUL byte → binary
    } finally {
      fs.closeSync(fd)
    }
    return textFileCoverage(fs.readFileSync(abs))
  } catch {
    return null
  }
}
