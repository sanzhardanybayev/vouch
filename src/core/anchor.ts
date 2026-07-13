export interface SymbolNode {
  name: string
  kindClass: 'function' | 'class' | 'other'
  range: [number, number] // 1-based inclusive full range
  children: SymbolNode[]
}

export function enclosingSymbol(
  roots: SymbolNode[], line: number, want: 'function' | 'class',
): { path: string; range: [number, number] } | null {
  type BestType = { path: string; range: [number, number]; depth: number }
  let best: BestType | null = null
  const visit = (nodes: SymbolNode[], prefix: string[], depth: number): void => {
    for (const n of nodes) {
      if (line < n.range[0] || line > n.range[1]) continue
      const path = [...prefix, n.name]
      if (n.kindClass === want && (best === null || depth > best.depth)) {
        best = { path: path.join('/'), range: n.range, depth }
      }
      visit(n.children, path, depth + 1)
    }
  }
  visit(roots, [], 0)
  if (best === null) return null
  const result: { path: string; range: [number, number] } = {
    path: (best as BestType).path,
    range: (best as BestType).range,
  }
  return result
}

export function resolveSymbolPath(roots: SymbolNode[], path: string): SymbolNode | null {
  const segments = path.split('/')
  let level = roots
  let node: SymbolNode | null = null
  for (const seg of segments) {
    node = level.find(n => n.name === seg) ?? null
    if (!node) return null
    level = node.children
  }
  return node
}

import { hashLines, normalizeEol, sha256, splitLines } from './text'
import type { ReviewRecord } from './types'

export type Status = 'reviewed' | 'dismissed'
export interface Resolution { status: Status; effectiveRange: [number, number] }
export const HUGE_FILE_LINES = 20_000

export function hashRangeOfText(
  docText: string, range: [number, number],
): { hash: string; headHash: string } {
  const lines = splitLines(docText)
  const slice = lines.slice(range[0] - 1, range[1])
  return { hash: hashLines(slice), headHash: sha256(slice[0] ?? '') }
}

export function resolveRecord(
  rec: ReviewRecord, docText: string, symbolRange?: [number, number] | null,
): Resolution {
  const lines = splitLines(docText)

  if (rec.kind === 'file') {
    const status: Status = sha256(normalizeEol(docText)) === rec.hash ? 'reviewed' : 'dismissed'
    return { status, effectiveRange: [1, Math.max(1, lines.length)] }
  }

  const stored: [number, number] = rec.range ?? [1, 1]
  const len = stored[1] - stored[0] + 1

  const windowMatches = (startIdx: number): boolean =>
    startIdx >= 0 && startIdx + len <= lines.length &&
    hashLines(lines.slice(startIdx, startIdx + len)) === rec.hash

  // Step 1 (spec §5): symbol range check
  if (symbolRange) {
    const [s, e] = symbolRange
    if (hashLines(lines.slice(s - 1, e)) === rec.hash) {
      return { status: 'reviewed', effectiveRange: [s, e] }
    }
    // fall through to scan — text may have moved elsewhere
  }

  // Step 2: two-stage scan (headHash line prefilter → full window confirm)
  if (lines.length > HUGE_FILE_LINES) {
    if (windowMatches(stored[0] - 1)) {
      return { status: 'reviewed', effectiveRange: stored }
    }
  } else if (rec.headHash) {
    const candidates: number[] = []
    for (let i = 0; i + len <= lines.length; i++) {
      if (sha256(lines[i]!) === rec.headHash) candidates.push(i)
    }
    let best: number | null = null
    for (const i of candidates) {
      if (!windowMatches(i)) continue
      if (best === null || Math.abs(i - (stored[0] - 1)) < Math.abs(best - (stored[0] - 1))) best = i
    }
    if (best !== null) {
      return { status: 'reviewed', effectiveRange: [best + 1, best + len] }
    }
  }

  // Dismissed: display at stored range clamped to document
  const maxLine = Math.max(1, lines.length)
  const start = Math.min(stored[0], maxLine)
  const end = Math.min(stored[1], maxLine)
  return { status: 'dismissed', effectiveRange: [start, Math.max(start, end)] }
}
