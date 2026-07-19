import { describe, it, expect } from 'vitest'
import { compileVouchIgnore } from '../../src/core/vouchignore'

const m = (src: string) => compileVouchIgnore(src)

describe('compileVouchIgnore', () => {
  it('empty source ignores nothing', () => {
    expect(m('').ignores('src/a.ts')).toBe(false)
  })

  it('blank lines and # comments are skipped', () => {
    const ig = m('\n# vendored stuff\n\nvendor/\n')
    expect(ig.ignores('vendor/lib.js')).toBe(true)
    expect(ig.ignores('src/a.ts')).toBe(false)
  })

  it('a bare name matches at any depth', () => {
    const ig = m('dist')
    expect(ig.ignores('dist')).toBe(true)
    expect(ig.ignores('dist/x.js')).toBe(true)
    expect(ig.ignores('packages/app/dist/x.js')).toBe(true)
    expect(ig.ignores('distx/y.js')).toBe(false)
  })

  it('a trailing slash matches the directory subtree', () => {
    const ig = m('vendor/')
    expect(ig.ignores('vendor/lib.js')).toBe(true)
    expect(ig.ignores('a/vendor/lib.js')).toBe(true)
    expect(ig.ignores('vendorized.ts')).toBe(false)
  })

  it('a leading slash anchors to the repo root', () => {
    const ig = m('/build')
    expect(ig.ignores('build/out.js')).toBe(true)
    expect(ig.ignores('build')).toBe(true)
    expect(ig.ignores('packages/build/out.js')).toBe(false)
  })

  it('* matches within a segment, never across /', () => {
    const ig = m('*.lock')
    expect(ig.ignores('yarn.lock')).toBe(true)
    expect(ig.ignores('sub/yarn.lock')).toBe(true)
    const anchored = m('/src/*.gen.ts')
    expect(anchored.ignores('src/x.gen.ts')).toBe(true)
    expect(anchored.ignores('src/deep/x.gen.ts')).toBe(false)
  })

  it('** crosses directory boundaries', () => {
    const ig = m('src/**/fixtures/**')
    expect(ig.ignores('src/a/fixtures/f.json')).toBe(true)
    expect(ig.ignores('src/a/b/fixtures/deep/f.json')).toBe(true)
    expect(ig.ignores('src/a/b.ts')).toBe(false)
  })

  it('? matches exactly one non-slash character', () => {
    const ig = m('file?.ts')
    expect(ig.ignores('file1.ts')).toBe(true)
    expect(ig.ignores('file12.ts')).toBe(false)
    expect(ig.ignores('file/.ts')).toBe(false)
  })

  it('! negation re-includes, last match wins', () => {
    const ig = m('vendor/\n!vendor/keep.ts')
    expect(ig.ignores('vendor/lib.js')).toBe(true)
    expect(ig.ignores('vendor/keep.ts')).toBe(false)
    const flipped = m('!vendor/keep.ts\nvendor/')
    expect(flipped.ignores('vendor/keep.ts')).toBe(true) // later rule wins
  })

  it('a pattern with an internal slash is anchored to the repo root', () => {
    const ig = m('docs/*.md')
    expect(ig.ignores('docs/a.md')).toBe(true)
    expect(ig.ignores('packages/x/docs/a.md')).toBe(false)
    const deep = m('a/b/')
    expect(deep.ignores('a/b/c.ts')).toBe(true)
    expect(deep.ignores('x/a/b/c.ts')).toBe(false)
  })

  it('a leading ** keeps a slash-containing pattern matching at any depth', () => {
    const ig = m('**/docs/*.md')
    expect(ig.ignores('docs/a.md')).toBe(true)
    expect(ig.ignores('packages/x/docs/a.md')).toBe(true)
  })

  it('regex metacharacters in patterns are inert', () => {
    const ig = m('a+b(1).ts')
    expect(ig.ignores('a+b(1).ts')).toBe(true)
    expect(ig.ignores('aab1.ts')).toBe(false)
  })
})
