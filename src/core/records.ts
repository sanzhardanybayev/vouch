import type { Author, ReviewRecord, Tombstone, VouchLine } from './types'
import { normalizeEmail } from './paths'

export function isTombstone(l: VouchLine): l is Tombstone {
  return 'revokes' in l
}

const KNOWN_KINDS = new Set<string>(['selection', 'function', 'class', 'file'])

/** False for records written by a future Vouch version. Such records still
 * participate in dedupe and chain topology (their supersedes edges and
 * tombstones must keep working on old clients), but resolve to not-reviewed. */
export function isKnownKind(rec: ReviewRecord): boolean {
  return KNOWN_KINDS.has(rec.kind)
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string'

function validAuthor(a: unknown): a is Author {
  return !!a && typeof a === 'object' && isStr((a as Author).name) && isStr((a as Author).email)
}

// Open validation: only the fields we consume are checked; unknown extra
// fields and unknown kind/reason VALUES are tolerated so future versions can
// extend the format without older clients flagging their lines as corrupt.
function validLine(obj: unknown): obj is VouchLine {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const o = obj as Record<string, unknown>
  if (!isStr(o.id) || !validAuthor(o.author) || !isStr(o.createdAt)) return false

  if ('revokes' in o) {
    return isStr(o.revokes) && isStr(o.reason) && o.reason !== '' && optStr(o.movedTo)
  }

  if (!isStr(o.kind) || o.kind === '' || !isStr(o.hash)) return false
  if (o.range !== undefined) {
    if (!Array.isArray(o.range) || o.range.length !== 2) return false
    const [s, e] = o.range as unknown[]
    if (typeof s !== 'number' || typeof e !== 'number') return false
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) return false
  }
  for (const k of [
    'headHash',
    'symbol',
    'anchorSymbol',
    'comment',
    'movedFrom',
    'ctxBefore',
    'ctxAfter',
  ]) {
    if (!optStr(o[k])) return false
  }
  if (o.supersedes !== undefined) {
    if (!Array.isArray(o.supersedes) || !o.supersedes.every(isStr)) return false
    if ((o.supersedes as string[]).includes(o.id)) return false // self-supersede: corrupt
  }
  return true
}

export function parseJsonl(content: string): { lines: VouchLine[]; corrupt: number } {
  const lines: VouchLine[] = []
  let corrupt = 0
  for (const raw of content.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      if (validLine(obj)) {
        // Coerce unvalidated provenance fields so downstream never crashes on
        // records written by external tools; both are informational only.
        if (!isTombstone(obj as VouchLine)) {
          if (!isStr(obj.commit)) obj.commit = ''
          if (typeof obj.dirty !== 'boolean') obj.dirty = false
        }
        lines.push(obj as unknown as VouchLine)
      } else corrupt++
    } catch {
      corrupt++
    }
  }
  return { lines, corrupt }
}

// Order-independent, revocation-monotone id-collision handling:
// - tombstones ALWAYS pass through (identical duplicates collapse); dropping a
//   tombstone could resurrect a revoked review, so a colliding id never can.
// - a record whose id collides with any tombstone id is dropped (fail-safe:
//   at worst hides a review, never revives one).
// - records sharing an id: identical content -> keep one (the normal
//   merge=union duplicate); differing content -> drop ALL and count corrupt,
//   so no platform-dependent readdir order ever picks a winner.
export function dedupeById(lines: VouchLine[]): { lines: VouchLine[]; corrupt: number } {
  const tombIds = new Set(lines.filter(isTombstone).map((t) => t.id))
  const out: VouchLine[] = []
  const seenTombs = new Set<string>()
  const recGroups = new Map<string, ReviewRecord[]>()
  for (const l of lines) {
    if (isTombstone(l)) {
      const key = JSON.stringify(l)
      if (!seenTombs.has(key)) {
        seenTombs.add(key)
        out.push(l)
      }
      continue
    }
    if (tombIds.has(l.id)) continue
    const g = recGroups.get(l.id) ?? []
    g.push(l)
    recGroups.set(l.id, g)
  }
  let corrupt = 0
  for (const g of recGroups.values()) {
    const distinct = new Set(g.map((r) => JSON.stringify(r)))
    if (distinct.size === 1) out.push(g[0]!)
    else corrupt += g.length
  }
  return { lines: out, corrupt }
}

export interface ChainState {
  current: ReviewRecord[]
  chains: Map<string, ReviewRecord[]>
  chainOf: Map<string, string>
  revokedChains: Set<string>
}

/** Copies of moved records found anywhere in the store, keyed by movedFrom id.
 * Used to grandfather legacy cross-author reason='moved' tombstones. */
export type MovedIndex = Map<string, { email: string; hash: string }[]>

const parsedTime = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Union-find over supersedes edges; tombstones kill whole chains.
 *
 * Trust boundaries (all .vouch data is untrusted, cross-user, git-merged):
 * - a supersedes edge between two present records is honored only when both
 *   share an author, so nobody can capture someone else's chain;
 * - a tombstone kills a chain only when every record in it belongs to the
 *   tombstone's author, or it is a reason='moved' tombstone whose moved copy
 *   is verified via movedIndex (same author, same hash) - the legacy reattach
 *   flow wrote cross-author moved tombstones and must not resurrect;
 * - within a chain, a record superseded by a present same-author record is
 *   never current (explicit topology beats timestamps, so clock skew cannot
 *   resurrect a replaced review); createdAt only breaks genuine tip ties.
 */
export function resolveChains(all: VouchLine[], movedIndex?: MovedIndex): ChainState {
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
  const byId = new Map(records.map((r) => [r.id, r]))
  const sameAuthor = (a: Author, b: Author): boolean =>
    normalizeEmail(a.email) === normalizeEmail(b.email)

  const superseded = new Set<string>()
  for (const r of records) {
    if (!parent.has(r.id)) parent.set(r.id, r.id)
    for (const prev of r.supersedes ?? []) {
      const target = byId.get(prev)
      // Cross-author edges are ignored entirely; edges to absent ids still
      // union (the id may be a lost/corrupt line of the same chain).
      if (target && !sameAuthor(target.author, r.author)) continue
      union(r.id, prev)
      if (target) superseded.add(prev)
    }
  }

  const chains = new Map<string, ReviewRecord[]>()
  for (const r of records) {
    const root = find(r.id)
    if (!chains.has(root)) chains.set(root, [])
    chains.get(root)!.push(r)
  }

  const movedVerified = (t: Tombstone): boolean => {
    if (t.reason !== 'moved') return false
    const target = byId.get(t.revokes)
    if (!target) return false
    const copies = movedIndex?.get(t.revokes) ?? []
    return copies.some(
      (c) =>
        normalizeEmail(c.email) === normalizeEmail(target.author.email) && c.hash === target.hash,
    )
  }

  // Revocation is per-author-partition, never per whole chain: a foreign
  // record that lands in the chain (e.g. by naming the same absent ancestor
  // id) must not be able to veto the author's own tombstone - and a
  // tombstone must never kill records the tombstone author doesn't own.
  const revokedIds = new Set<string>()
  for (const t of tombs) {
    if (!parent.has(t.revokes)) continue
    const root = find(t.revokes)
    const members = chains.get(root) ?? []
    if (members.length === 0) continue
    if (movedVerified(t)) {
      for (const m of members) revokedIds.add(m.id)
      continue
    }
    for (const m of members) {
      if (sameAuthor(m.author, t.author)) revokedIds.add(m.id)
    }
  }

  const chainOf = new Map<string, string>()
  const current: ReviewRecord[] = []
  const revokedChains = new Set<string>()
  for (const [root, members] of chains) {
    members.sort(
      (a, b) => parsedTime(a.createdAt) - parsedTime(b.createdAt) || (a.id < b.id ? -1 : 1),
    )
    for (const m of members) chainOf.set(m.id, root)
    if (members.every((m) => revokedIds.has(m.id))) revokedChains.add(root)
    // Tips are selected per author partition: honored supersedes edges are
    // same-author-only, so authors sharing a chain (via absent-ancestor
    // unions) each own an independent lineage - a foreign record with a
    // later (forgeable) createdAt must never displace another author's live
    // review. Within a partition, a hand-made cycle (only producible by
    // edited data) yields zero unsuperseded tips; fall back to all alive
    // members so an unrevoked lineage never silently vanishes.
    const alive = members.filter((m) => !revokedIds.has(m.id))
    if (alive.length === 0) continue
    const byAuthor = new Map<string, ReviewRecord[]>()
    for (const m of alive) {
      const key = normalizeEmail(m.author.email)
      const g = byAuthor.get(key) ?? []
      g.push(m)
      byAuthor.set(key, g)
    }
    for (const g of byAuthor.values()) {
      let tips = g.filter((m) => !superseded.has(m.id))
      if (tips.length === 0) tips = g
      current.push(tips[tips.length - 1]!)
    }
  }

  return { current, chains, chainOf, revokedChains }
}
