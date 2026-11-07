import * as vscode from 'vscode'
import { looksFunctionValued, type SymbolNode } from '../core/anchor'
import { sniffRustItem } from '../core/rust'

function kindClass(s: vscode.DocumentSymbol, doc: vscode.TextDocument): SymbolNode['kindClass'] {
  const K = vscode.SymbolKind
  const kind = s.kind
  if (kind === K.Function || kind === K.Method || kind === K.Constructor) return 'function'
  if (kind === K.Class || kind === K.Interface || kind === K.Struct || kind === K.Enum)
    return 'class'
  // Language servers report `const f = () => {}` (and function-valued class
  // fields) as variable-kind symbols; sniff the declaration text.
  if (
    (kind === K.Variable || kind === K.Constant || kind === K.Property || kind === K.Field) &&
    looksFunctionValued(doc.getText(s.range))
  )
    return 'function'
  return 'other'
}

// The declaration head (comments, attributes, keywords) runs from the
// symbol's start to its name; servers that don't separate the two get the
// first line instead. Bounded either way - never the whole item body.
function rustItem(s: vscode.DocumentSymbol, doc: vscode.TextDocument): SymbolNode['item'] {
  const head = s.selectionRange.start.isAfter(s.range.start)
    ? new vscode.Range(s.range.start, s.selectionRange.start)
    : doc.lineAt(s.range.start.line).range
  return sniffRustItem(doc.getText(head) + ' ' + s.name) ?? undefined
}

function toNode(s: vscode.DocumentSymbol, doc: vscode.TextDocument): SymbolNode {
  const node: SymbolNode = {
    name: s.name,
    kindClass: kindClass(s, doc),
    range: [s.range.start.line + 1, s.range.end.line + 1],
    children: s.children.map((c) => toNode(c, doc)),
  }
  if (doc.languageId === 'rust') {
    const item = rustItem(s, doc)
    if (item) node.item = item
  }
  return node
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
  const doc = await vscode.workspace.openTextDocument(uri)
  return (result as vscode.DocumentSymbol[]).map((s) => toNode(s, doc))
}
