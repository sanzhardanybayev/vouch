import { describe, it, expect } from 'vitest'
import { filtersHtml } from '../../src/core/filtershtml'

describe('filtersHtml', () => {
  const html = filtersHtml('vscode-resource:', 'n0nce')

  it('locks the page down with a nonce-only script CSP', () => {
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'nonce-n0nce'")
    expect(html).toContain('<script nonce="n0nce">')
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  it('renders the three controls', () => {
    expect(html).toContain('type="checkbox" id="hide"')
    expect(html).toContain('<select id="reviewer">')
    expect(html).toContain('type="text" id="path"')
  })

  it('fills untrusted reviewer text through textContent, never innerHTML', () => {
    expect(html).not.toContain('innerHTML')
    expect(html).toContain('o.textContent = r.name')
  })

  it('keeps a saved reviewer selectable when it is no longer in the list', () => {
    expect(html).toContain("o.textContent = want + ' (no current reviews)'")
    expect(html).toContain('reviewer.value = want')
  })
})
