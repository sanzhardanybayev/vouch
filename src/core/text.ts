import { createHash } from 'node:crypto'

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Anchoring view of a document: raw LF split, trailing empty segment kept. */
export function splitLines(text: string): string[] {
  return normalizeEol(text).split('\n')
}

/** Coverage line count: trailing newline adds no line; '' is 0 lines. */
export function countLines(text: string): number {
  const t = normalizeEol(text)
  if (t === '') return 0
  const parts = t.split('\n')
  return t.endsWith('\n') ? parts.length - 1 : parts.length
}

/** Whitespace-only lines carry no code, so they need no review. */
export function isBlankLine(line: string): boolean {
  return line.trim() === ''
}

/**
 * 1-based numbers of the lines that count toward coverage: every line under
 * the countLines convention except blank (whitespace-only) ones. A file of
 * two fully reviewed functions separated by an empty line must read 100%.
 */
export function codeLineNumbers(text: string): number[] {
  const total = countLines(text)
  const lines = splitLines(text)
  const out: number[] = []
  for (let i = 0; i < total; i++) {
    if (!isBlankLine(lines[i] ?? '')) out.push(i + 1)
  }
  return out
}

export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

export function hashLines(lines: string[]): string {
  return sha256(lines.join('\n'))
}
