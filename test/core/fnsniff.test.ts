import { describe, it, expect } from 'vitest'
import { looksFunctionValued } from '../../src/core/anchor'

describe('looksFunctionValued', () => {
  it('const with multi-line arrow initializer (destructured params)', () => {
    expect(
      looksFunctionValued(
        [
          'const resolveTokenUser = ({',
          '  accessToken,',
          '  explicitUser,',
          '}: Args): AuthUser => {',
          '  return explicitUser',
          '}',
        ].join('\n'),
      ),
    ).toBe(true)
  })
  it('single-line arrow', () => {
    expect(looksFunctionValued('const double = (x: number) => x * 2')).toBe(true)
  })
  it('arrow without parens', () => {
    expect(looksFunctionValued('const id = x => x')).toBe(true)
  })
  it('async arrow', () => {
    expect(looksFunctionValued('const load = async () => fetch(url)')).toBe(true)
  })
  it('generic arrow', () => {
    expect(looksFunctionValued('const first = <T>(xs: T[]) => xs[0]')).toBe(true)
  })
  it('function expression', () => {
    expect(looksFunctionValued('const f = function (a) { return a }')).toBe(true)
  })
  it('async function expression', () => {
    expect(looksFunctionValued('const f = async function () {}')).toBe(true)
  })
  it('object literal with arrow property is NOT function-valued', () => {
    expect(looksFunctionValued('const obj = { method: () => 2 }')).toBe(false)
  })
  it('array literal containing arrows is NOT function-valued', () => {
    expect(looksFunctionValued('const fns = [(x) => x]')).toBe(false)
  })
  it('string containing arrow is NOT function-valued', () => {
    expect(looksFunctionValued("const s = 'a => b'")).toBe(false)
  })
  it('plain value is NOT function-valued', () => {
    expect(looksFunctionValued('const n = (a + b) * 2')).toBe(false)
  })
  it('no initializer at all', () => {
    expect(looksFunctionValued('let pending')).toBe(false)
  })
  it('type-annotated arrow const', () => {
    expect(looksFunctionValued('const fn: Handler = (req) => req.id')).toBe(true)
  })
})
