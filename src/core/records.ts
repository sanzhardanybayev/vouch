import type { ReviewRecord, Tombstone, VouchLine } from './types'

export function isTombstone(l: VouchLine): l is Tombstone {
  return 'revokes' in l
}

export function parseJsonl(content: string): { lines: VouchLine[]; corrupt: number } {
  const lines: VouchLine[] = []
  let corrupt = 0
  for (const raw of content.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s) as VouchLine
      if (typeof (obj as { id?: unknown }).id === 'string') lines.push(obj)
      else corrupt++
    } catch {
      corrupt++
    }
  }
  return { lines, corrupt }
}

export function dedupeById(lines: VouchLine[]): VouchLine[] {
  const seen = new Set<string>()
  const out: VouchLine[] = []
  for (const l of lines) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    out.push(l)
  }
  return out
}

export interface ChainState {
  current: ReviewRecord[]
  chains: Map<string, ReviewRecord[]>
  chainOf: Map<string, string>
  revokedChains: Set<string>
}

/** Union-find over supersedes edges; tombstones kill whole chains. */
export function resolveChains(all: VouchLine[]): ChainState {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  const records = all.filter((l): l is ReviewRecord => !isTombstone(l))
  const tombs = all.filter(isTombstone)

  for (const r of records) {
    if (!parent.has(r.id)) parent.set(r.id, r.id)
    for (const prev of r.supersedes ?? []) union(r.id, prev)
  }

  const revokedChains = new Set<string>()
  for (const t of tombs) {
    if (parent.has(t.revokes)) revokedChains.add(find(t.revokes))
  }

  const chains = new Map<string, ReviewRecord[]>()
  for (const r of records) {
    const root = find(r.id)
    if (!chains.has(root)) chains.set(root, [])
    chains.get(root)!.push(r)
  }

  const chainOf = new Map<string, string>()
  const current: ReviewRecord[] = []
  for (const [root, members] of chains) {
    members.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
    for (const m of members) chainOf.set(m.id, root)
    if (!revokedChains.has(root)) current.push(members[members.length - 1]!)
  }

  return { current, chains, chainOf, revokedChains }
}
