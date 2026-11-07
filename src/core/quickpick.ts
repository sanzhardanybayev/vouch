/**
 * Make untrusted text (record authors, symbols, paths) safe for a QuickPick
 * label, description or detail. Those render `$(name)` as a codicon, so a
 * crafted record could draw status icons into the menu; VS Code shows an
 * escaped `\$(name)` as the literal text `$(name)`.
 */
export function escapeIcons(text: string): string {
  return text.replace(/\$\(/g, '\\$(')
}
