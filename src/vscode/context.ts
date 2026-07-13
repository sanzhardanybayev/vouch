import * as vscode from 'vscode'
import * as path from 'node:path'
import { ReviewStore } from '../core/store'
import { repoRoot } from './gitinfo'

export interface RootEntry { rootDir: string; store: ReviewStore }

export class VouchContext {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.emitter.event

  private constructor(readonly roots: RootEntry[]) {}

  static async create(): Promise<VouchContext> {
    const dirs = new Set<string>()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = (await repoRoot(folder.uri.fsPath)) ?? folder.uri.fsPath
      dirs.add(root)
    }
    const roots: RootEntry[] = []
    for (const rootDir of dirs) {
      const store = new ReviewStore(rootDir)
      await store.load()
      roots.push({ rootDir, store })
    }
    return new VouchContext(roots)
  }

  rootFor(uri: vscode.Uri): RootEntry | null {
    const p = uri.fsPath
    let best: RootEntry | null = null
    for (const r of this.roots) {
      const rel = path.relative(r.rootDir, p)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (!best || r.rootDir.length > best.rootDir.length) best = r
    }
    return best
  }

  sourcePathOf(uri: vscode.Uri): string | null {
    const root = this.rootFor(uri)
    if (!root) return null
    return path.relative(root.rootDir, uri.fsPath).split(path.sep).join('/')
  }

  async reload(): Promise<void> {
    for (const r of this.roots) await r.store.load()
    this.emitter.fire()
  }
}
