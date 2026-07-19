import { hashLines, normalizeEol, sha256, splitLines } from './text'
import { isKnownKind } from './records'
import type { ReviewRecord } from './types'

export interface SymbolNode {
  name: string
  kindClass: 'function' | 'class' | 'other'
  range: [number, number] // 1-based inclusive full range
  children: SymbolNode[]
}

type SymbolWant = 'function' | 'class' | 'any'
const wants = (n: SymbolNode, want: SymbolWant): boolean =>
  want === 'any' ? n.kindClass !== 'other' : n.kindClass === want

export function enclosingSymbol(
  roots: SymbolNode[], line: number, want: 'function' | 'class',
): { path: string; range: [number, number] } | null {
  return enclosingSymbolOfRange(roots, [line, line], want)
}

/** Deepest function/class symbol whose range encloses the WHOLE given range. */
export function enclosingSymbolOfRange(
  roots: SymbolNode[], range: [number, number], want: SymbolWant,
): { path: string; range: [number, number] } | null {
  let best: { path: string; range: [number, number]; depth: number } | null = null
  const visit = (nodes: SymbolNode[], prefix: string[], depth: number): void => {
    for (const n of nodes) {
      if (range[0] < n.range[0] || range[1] > n.range[1]) continue
      const path = [...prefix, n.name]
      if (wants(n, want) && (best === null || depth > best.depth)) {
        best = { path: path.join('/'), range: n.range, depth }
      }
      visit(n.children, path, depth + 1)
    }
  }
  visit(roots, [], 0)
  return best === null ? null : {
    path: (best as { path: string }).path,
    range: (best as { range: [number, number] }).range,
  }
}

/** Every node matching the hierarchical path — duplicates (overloads, copies)
 * are real and callers must treat >1 matches as an unverifiable location. */
export function resolveSymbolPathAll(roots: SymbolNode[], path: string): SymbolNode[] {
  let level = roots
  let matches: SymbolNode[] = []
  for (const [i, seg] of path.split('/').entries()) {
    const pool = i === 0 ? level : matches.flatMap(n => n.children)
    matches = pool.filter(n => n.name === seg)
    if (matches.length === 0) return []
    level = []
  }
  return matches
}

export function resolveSymbolPath(roots: SymbolNode[], path: string): SymbolNode | null {
  return resolveSymbolPathAll(roots, path)[0] ?? null
}

export type Status = 'reviewed' | 'dismissed' | 'ambiguous'
export interface Resolution {
  status: Status
  effectiveRange: [number, number]
  /** Present iff ambiguous: every structurally plausible location, nearest to
   * the stored range first (display/resolve-flow input, capped). */
  candidates?: [number, number][]
}

/** Files above this line count skip the full-file scan (bounded probes only). */
export const HUGE_FILE_LINES = 100_000
/** More content matches than this → ambiguous without further scanning. */
export const CONFIRM_CAP = 32
const CTX_LINES = 2

/** Per-document scan accelerator; build ONCE per text and share across all
 * records of the file so full-file scans stay linear per refresh. */
export interface LineIndex { lines: string[]; lineHashes: string[] | null }

export function buildLineIndex(docText: string): LineIndex {
  const lines = splitLines(docText)
  const lineHashes = lines.length <= HUGE_FILE_LINES ? lines.map(l => sha256(l)) : null
  return { lines, lineHashes }
}

/** Soft location signal: hashes of up to CTX_LINES lines directly above/below
 * a range. Top/bottom of file hash the empty string, so capture and resolve
 * agree without a sentinel. */
export function ctxHashes(
  lines: string[], range: [number, number],
): { before: string; after: string } {
  const before = lines.slice(Math.max(0, range[0] - 1 - CTX_LINES), Math.max(0, range[0] - 1))
  const after = lines.slice(range[1], range[1] + CTX_LINES)
  return { before: sha256(before.join('\n')), after: sha256(after.join('\n')) }
}

export function hashRangeOfText(
  docText: string, range: [number, number],
): { hash: string; headHash: string } {
  const lines = splitLines(docText)
  const slice = lines.slice(range[0] - 1, range[1])
  return { hash: hashLines(slice), headHash: sha256(slice[0] ?? '') }
}

/**
 * Resolve a record against the current text (spec: issue #2).
 *
 * Signal roles: content hash and recorded symbol path are HARD (must verify
 * for 'reviewed'); ctx hashes and the stored range are SOFT (tiebreak/display
 * only). Conservative rule: an unverifiable hard signal degrades toward
 * 'ambiguous', never toward 'reviewed' — no silent wrong green, ever.
 *
 * `symbols === null` means the provider is unavailable/unverifiable (warmup,
 * flat SymbolInformation shape, text-only callers). Callers must never pass
 * an empty array for those cases — see vscode/symbols.ts.
 */
export function resolveRecord(
  rec: ReviewRecord, docText: string,
  symbols: SymbolNode[] | null = null, index?: LineIndex,
): Resolution {
  const idx = index ?? buildLineIndex(docText)
  const lines = idx.lines

  if (!isKnownKind(rec)) return dismissedAt(rec.range, lines) // future version's record
  if (rec.kind === 'file') {
    const status: Status = sha256(normalizeEol(docText)) === rec.hash ? 'reviewed' : 'dismissed'
    return { status, effectiveRange: [1, Math.max(1, lines.length)] }
  }

  const stored: [number, number] = rec.range ?? [1, 1]
  const len = stored[1] - stored[0] + 1
  if (!Number.isInteger(len) || len < 1) return dismissedAt(stored, lines)

  const windowMatches = (i: number): boolean =>
    Number.isInteger(i) && i >= 0 && i + len <= lines.length &&
    hashLines(lines.slice(i, i + len)) === rec.hash
  const rangeOf = (i: number): [number, number] => [i + 1, i + len]
  const hasCtx = typeof rec.ctxBefore === 'string' && typeof rec.ctxAfter === 'string'
  const ctxOk = (i: number): boolean => {
    const { before, after } = ctxHashes(lines, rangeOf(i))
    return before === rec.ctxBefore && after === rec.ctxAfter
  }
  const atStored = (i: number): boolean => i === stored[0] - 1
  const reviewedAt = (i: number): Resolution => ({ status: 'reviewed', effectiveRange: rangeOf(i) })
  const ambiguousAt = (cands: number[]): Resolution => {
    const sorted = [...cands]
      .sort((a, b) => Math.abs(a - (stored[0] - 1)) - Math.abs(b - (stored[0] - 1)) || a - b)
      .slice(0, CONFIRM_CAP)
    return { status: 'ambiguous', effectiveRange: rangeOf(sorted[0]!), candidates: sorted.map(rangeOf) }
  }

  // Location signal: `symbol` (function/class kinds) or `anchorSymbol`
  // (selections; '' = explicit top-level sentinel).
  const locSym = rec.symbol ?? rec.anchorSymbol

  // ── Candidate collection ──────────────────────────────────────────────
  // Complete path: headHash line prefilter over the shared index + full-window
  // confirm. Bounded path (no headHash, or file over the scan cap): probe the
  // stored range, plus a scan within the single resolved symbol when there is
  // one — the candidate set is then INCOMPLETE and uniqueness-premised rules
  // must not run on it.
  let candidates: number[] = []
  const complete = !!rec.headHash && idx.lineHashes !== null
  if (complete) {
    for (let i = 0; i + len <= lines.length; i++) {
      if (idx.lineHashes![i] !== rec.headHash) continue
      if (!windowMatches(i)) continue
      candidates.push(i)
      if (candidates.length > CONFIRM_CAP) return ambiguousAt(candidates)
    }
  } else {
    const probes = new Set<number>()
    if (windowMatches(stored[0] - 1)) probes.add(stored[0] - 1)
    if (locSym !== undefined && locSym !== '' && symbols) {
      const matches = resolveSymbolPathAll(symbols, locSym)
      if (matches.length === 1) {
        const [ss, se] = matches[0]!.range
        for (let i = Math.max(0, ss - 1); i + len <= Math.min(lines.length, se); i++) {
          if (rec.headHash && sha256(lines[i]!) !== rec.headHash) continue
          if (windowMatches(i)) probes.add(i)
          if (probes.size > CONFIRM_CAP) break
        }
      }
    }
    candidates = [...probes].sort((a, b) => a - b)
  }

  if (candidates.length === 0) return dismissedAt(stored, lines)

  // ── Symbol layer (hard) ───────────────────────────────────────────────
  if (locSym !== undefined) {
    if (symbols) {
      if (locSym === '') {
        // Top-level sentinel: candidates enclosed by a function/class moved
        // out of the reviewed (top-level) context. Ambiguous, not dismissed:
        // a warming language server can mint a stale sentinel at capture, so
        // this must stay recoverable through the resolve flow.
        const topLevel = candidates.filter(i =>
          enclosingSymbolOfRange(symbols, rangeOf(i), 'any') === null)
        if (topLevel.length === 0) return ambiguousAt(candidates)
        candidates = topLevel
      } else {
        const matches = resolveSymbolPathAll(symbols, locSym)
        if (matches.length === 0) return ambiguousAt(candidates) // renamed/deleted: orphaned
        if (matches.length > 1) {
          // Duplicate symbol names: location unverifiable; only a unique ctx
          // survivor may still resolve.
          const surv = hasCtx ? candidates.filter(ctxOk) : []
          return surv.length === 1 ? reviewedAt(surv[0]!) : ambiguousAt(candidates)
        }
        const [ss, se] = matches[0]!.range
        const inside = candidates.filter(i => i + 1 >= ss && i + len <= se)
        if (inside.length === 0) return dismissedAt(stored, lines) // moved out of context
        candidates = inside
      }
    } else {
      // Symbol recorded but unverifiable: reviewed only for the lowest-risk
      // shape — a complete scan proving a single candidate that sits exactly
      // at the stored range with ctx agreeing (or no ctx recorded).
      if (complete && candidates.length === 1 && atStored(candidates[0]!) &&
        (!hasCtx || ctxOk(candidates[0]!))) {
        return reviewedAt(candidates[0]!)
      }
      return ambiguousAt(candidates)
    }
  }

  // ── Bounded-path green gate ───────────────────────────────────────────
  if (!complete) {
    if (hasCtx) {
      const surv = candidates.filter(ctxOk)
      return surv.length === 1 ? reviewedAt(surv[0]!) : ambiguousAt(candidates)
    }
    // Legacy record on an incomplete scan: only the exact stored position is
    // trustworthy (documented trade-off: no shipped client writes this shape).
    if (candidates.length === 1 && atStored(candidates[0]!)) return reviewedAt(candidates[0]!)
    return ambiguousAt(candidates)
  }

  // ── Complete path: uniqueness, then ctx tiebreak ──────────────────────
  if (candidates.length === 1) return reviewedAt(candidates[0]!)
  if (hasCtx) {
    const surv = candidates.filter(ctxOk)
    if (surv.length === 1) return reviewedAt(surv[0]!)
  }
  // Multiple identical matches nothing can tell apart → never guess.
  return ambiguousAt(candidates)
}

// Dismissed: display at stored range clamped to the document. Ranges come
// from shared .vouch/ records and are untrusted, so clamp both bounds into
// [1, maxLine] and coerce non-finite values to 1 — callers feed
// effectiveRange straight into vscode.Range, whose Position constructor
// throws on negative lines.
function dismissedAt(range: [number, number] | undefined, lines: string[]): Resolution {
  const stored = range ?? [1, 1]
  const maxLine = Math.max(1, lines.length)
  const clampLine = (n: number): number =>
    Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), maxLine) : 1
  const start = clampLine(stored[0])
  const end = clampLine(stored[1])
  return { status: 'dismissed', effectiveRange: [start, Math.max(start, end)] }
}
