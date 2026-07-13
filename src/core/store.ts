import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { dedupeById, parseJsonl, resolveChains, type ChainState } from './records'
import { sourcePathOfShard } from './paths'
import type { VouchLine } from './types'

export class ReviewStore {
  private bySource = new Map<string, ChainState>()
  corruptLines = 0

  constructor(private readonly rootDir: string) {}

  async load(): Promise<void> {
    this.bySource = new Map()
    this.corruptLines = 0
    const reviewsDir = join(this.rootDir, '.vouch', 'reviews')
    const shardFiles = await walk(reviewsDir)
    const linesBySource = new Map<string, VouchLine[]>()
    for (const abs of shardFiles) {
      const rel = join('.vouch', 'reviews', relative(reviewsDir, abs))
      const source = sourcePathOfShard(rel)
      if (!source) continue
      const { lines, corrupt } = parseJsonl(await readFile(abs, 'utf8'))
      this.corruptLines += corrupt
      if (!linesBySource.has(source)) linesBySource.set(source, [])
      linesBySource.get(source)!.push(...lines)
    }
    for (const [source, lines] of linesBySource) {
      this.bySource.set(source, resolveChains(dedupeById(lines)))
    }
  }

  stateFor(sourcePath: string): ChainState | undefined {
    return this.bySource.get(sourcePath)
  }

  attestedFiles(): string[] {
    return [...this.bySource.entries()]
      .filter(([, s]) => s.current.length > 0)
      .map(([p]) => p)
      .sort()
  }

  orphans(exists: (sourcePath: string) => boolean): string[] {
    return this.attestedFiles().filter(p => !exists(p))
  }

  counts(): { records: number; perAuthor: Map<string, { name: string; current: number }> } {
    let records = 0
    const perAuthor = new Map<string, { name: string; current: number }>()
    for (const s of this.bySource.values()) {
      for (const r of s.current) {
        records++
        const entry = perAuthor.get(r.author.email) ?? { name: r.author.name, current: 0 }
        entry.current++
        perAuthor.set(r.author.email, entry)
      }
    }
    return { records, perAuthor }
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}
