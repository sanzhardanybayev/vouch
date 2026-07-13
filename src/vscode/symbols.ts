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

export async function documentSymbols(uri: vscode.Uri): Promise<SymbolNode[]> {
  const result = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri)
  if (!result || result.length === 0) return []
  // Spec §5: only the hierarchical DocumentSymbol shape is trusted.
  if (!('children' in result[0]!)) return []
  return (result as vscode.DocumentSymbol[]).map(toNode)
}
