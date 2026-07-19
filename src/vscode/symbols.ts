import * as vscode from 'vscode'
import type { SymbolNode } from '../core/anchor'

function kindClass(kind: vscode.SymbolKind): SymbolNode['kindClass'] {
  const K = vscode.SymbolKind
  if (kind === K.Function || kind === K.Method || kind === K.Constructor) return 'function'
  if (kind === K.Class || kind === K.Interface || kind === K.Struct || kind === K.Enum) return 'class'
  return 'other'
}

function toNode(s: vscode.DocumentSymbol): SymbolNode {
  return {
    name: s.name,
    kindClass: kindClass(s.kind),
    range: [s.range.start.line + 1, s.range.end.line + 1],
    children: s.children.map(toNode),
  }
}

/**
 * null = unverifiable. That covers: no provider, a provider that answered
 * empty (indistinguishable from a still-warming language server), and the
 * flat SymbolInformation shape (unusable for hierarchical path resolution;
 * spec §5 trusts only DocumentSymbol). Any record carrying a symbol anchor
 * was captured in a file that HAD symbols, so a trustworthy provider answers
 * non-empty for that file — which makes the resolver's "symbol path not
 * found -> orphaned" branch sound exactly when this returns a real tree.
 */
export async function documentSymbols(uri: vscode.Uri): Promise<SymbolNode[] | null> {
  const result = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri)
  if (!result || result.length === 0) return null
  if (!('children' in result[0]!)) return null
  return (result as vscode.DocumentSymbol[]).map(toNode)
}
