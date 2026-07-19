import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { dedupeById, parseJsonl, resolveChains, type ChainState, type MovedIndex } from './records'
import { sourcePathOfShard } from './paths'
import type { VouchLine } from './types'

export interface EngineerSummary {
  name: string
  email: string
  reviewCount: number
  files: { sourcePath: string; count: number }[]
}

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
    const dedupedBySource = new Map<string, VouchLine[]>()
    for (const [source, lines] of linesBySource) {
      const { lines: deduped, corrupt } = dedupeById(lines)
      this.corruptLines += corrupt
      dedupedBySource.set(source, deduped)
    }
    // Moved copies live under a DIFFERENT source path than the tombstones that
    // revoked their originals, so the index must span the whole store. Every
    // parsed line counts, current or not: a later unvouch of the moved copy
    // must not resurrect the old-path record.
    const movedIndex: MovedIndex = new Map()
    for (const lines of dedupedBySource.values()) {
      for (const l of lines) {
        const movedFrom = (l as { movedFrom?: string }).movedFrom
        const hash = (l as { hash?: string }).hash
        const email = l.author.email
        if (!movedFrom || typeof hash !== 'string') continue
        if (!movedIndex.has(movedFrom)) movedIndex.set(movedFrom, [])
        movedIndex.get(movedFrom)!.push({ email, hash })
      }
    }
    for (const [source, lines] of dedupedBySource) {
      this.bySource.set(source, resolveChains(lines, movedIndex))
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

  perEngineer(): EngineerSummary[] {
    // email -> { name, total, perFile: Map<sourcePath, count> }
    const byEmail = new Map<string, { name: string; total: number; perFile: Map<string, number> }>()
    for (const [sourcePath, state] of this.bySource) {
      for (const r of state.current) {
        let e = byEmail.get(r.author.email)
        if (!e) { e = { name: r.author.name, total: 0, perFile: new Map() }; byEmail.set(r.author.email, e) }
        e.total++
        e.perFile.set(sourcePath, (e.perFile.get(sourcePath) ?? 0) + 1)
      }
    }
    const out: EngineerSummary[] = []
    for (const [email, e] of byEmail) {
      const files = [...e.perFile.entries()]
        .map(([sourcePath, count]) => ({ sourcePath, count }))
        .sort((a, b) => b.count - a.count || a.sourcePath.localeCompare(b.sourcePath))
      out.push({ name: e.name, email, reviewCount: e.total, files })
    }
    out.sort((a, b) => b.reviewCount - a.reviewCount || a.name.localeCompare(b.name))
    return out
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
