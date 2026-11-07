// Markup for the coverage tree's Filters view. Static on purpose: reviewer
// names and the regex come from shared .vouch/ records or user input and are
// untrusted, so they never enter this string - the script fills them in
// through textContent/value only, from the state message the extension posts.
export function filtersHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 4px 8px; }
  label { display: block; margin: 6px 0 2px; }
  label.row { display: flex; align-items: center; gap: 6px; }
  select, input[type=text] {
    width: 100%; box-sizing: border-box; padding: 3px 4px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input[type=text].invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  #error { color: var(--vscode-errorForeground); min-height: 1.2em; margin-top: 2px; word-break: break-word; }
  button {
    margin-top: 6px; padding: 2px 10px; border: none;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
</style></head><body>
<label class="row"><input type="checkbox" id="hide"> Hide files with no reviews</label>
<label for="reviewer">Reviewer</label>
<select id="reviewer"><option value="">All reviewers</option></select>
<label for="path">Path regex</label>
<input type="text" id="path" placeholder="e.g. ^src/core/  or  \\.test\\.ts$" spellcheck="false">
<div id="error"></div>
<button id="reset">Reset</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  const hide = document.getElementById('hide')
  const reviewer = document.getElementById('reviewer')
  const pathInput = document.getElementById('path')
  const error = document.getElementById('error')
  const send = () => vscode.postMessage({
    type: 'set',
    filter: { hideUnreviewed: hide.checked, reviewer: reviewer.value, pathRegex: pathInput.value },
  })
  let timer
  hide.addEventListener('change', send)
  reviewer.addEventListener('change', send)
  pathInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(send, 250) })
  document.getElementById('reset').addEventListener('click', () => vscode.postMessage({ type: 'reset' }))
  window.addEventListener('message', (e) => {
    const m = e.data
    if (!m || m.type !== 'state') return
    hide.checked = !!m.filter.hideUnreviewed
    reviewer.replaceChildren()
    const all = document.createElement('option')
    all.value = ''
    all.textContent = 'All reviewers'
    reviewer.appendChild(all)
    for (const r of m.reviewers) {
      const o = document.createElement('option')
      o.value = r.email
      o.textContent = r.name + ' <' + r.email + '>'
      reviewer.appendChild(o)
    }
    reviewer.value = m.filter.reviewer || ''
    // Never clobber what the user is typing with an echo of older state.
    if (document.activeElement !== pathInput) pathInput.value = m.filter.pathRegex
    error.textContent = m.error || ''
    pathInput.classList.toggle('invalid', !!m.error)
  })
  vscode.postMessage({ type: 'ready' })
</script></body></html>`
}
