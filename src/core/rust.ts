// Rust item scopes for the language-specific review commands.
//
// Language servers flatten Rust items onto the generic LSP SymbolKind set
// (rust-analyzer: struct/union -> Struct, trait -> Interface, impl -> Object,
// mod -> Module, macro_rules! -> Function), so the kind alone can't tell a
// macro from a function or a union from a struct. The declaration head can:
// strip what may precede the keyword (comments, attributes, visibility,
// qualifiers) and read the keyword itself.

export type RustItem = 'struct' | 'enum' | 'trait' | 'impl' | 'mod' | 'macro'

export const RUST_ITEMS: readonly RustItem[] = ['struct', 'enum', 'trait', 'impl', 'mod', 'macro']

const QUALIFIERS = /^(?:unsafe|default|const|async|auto)\b\s*/
const EXTERN = /^extern\b\s*(?:"(?:[^"\\]|\\.)*"\s*)?/
const VISIBILITY = /^pub\b\s*(?:\(\s*(?:crate|self|super|in\s+[\w:]+)\s*\)\s*)?/

/** Classify a Rust declaration by its head; null for anything else (fn, const, use, ...). */
export function sniffRustItem(text: string): RustItem | null {
  let s = skipTrivia(text)
  if (s === null) return null
  const vis = VISIBILITY.exec(s)
  if (vis) s = s.slice(vis[0].length)
  for (;;) {
    const q = QUALIFIERS.exec(s) ?? EXTERN.exec(s)
    if (!q || q[0].length === 0) break
    s = s.slice(q[0].length)
  }
  if (/^macro_rules\s*!/.test(s)) return 'macro'
  if (/^macro\s+[A-Za-z_]/.test(s)) return 'macro' // declarative macros 2.0
  const kw = /^(struct|union|enum|trait|impl|mod)\b/.exec(s)?.[1]
  if (kw === undefined) return null
  return kw === 'union' ? 'struct' : (kw as RustItem)
}

/** Drop leading whitespace, comments (nested block comments too) and
 * attributes. null when a comment or attribute never closes. */
function skipTrivia(text: string): string | null {
  let i = 0
  const n = text.length
  for (;;) {
    while (i < n && /\s/.test(text[i]!)) i++
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i)
      if (nl < 0) return ''
      i = nl + 1
      continue
    }
    if (text.startsWith('/*', i)) {
      let depth = 0
      while (i < n) {
        if (text.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (text.startsWith('*/', i)) {
          depth--
          i += 2
          if (depth === 0) break
        } else i++
      }
      if (depth !== 0) return null
      continue
    }
    if (text.startsWith('#[', i) || text.startsWith('#![', i)) {
      const end = attributeEnd(text, text.indexOf('[', i))
      if (end < 0) return null
      i = end
      continue
    }
    return text.slice(i)
  }
}

/** Index just past the `]` closing the attribute opened at `open`; string
 * literals may contain brackets. -1 when unbalanced. */
function attributeEnd(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i + 1
  }
  return -1
}
