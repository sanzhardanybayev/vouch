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
