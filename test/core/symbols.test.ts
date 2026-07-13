import { describe, it, expect } from 'vitest'
import { enclosingSymbol, resolveSymbolPath, type SymbolNode } from '../../src/core/anchor'

const TREE: SymbolNode[] = [
  {
    name: 'AuthService', kindClass: 'class', range: [10, 100],
    children: [
      { name: 'login', kindClass: 'function', range: [20, 40], children: [] },
      { name: 'logout', kindClass: 'function', range: [50, 60], children: [] },
    ],
  },
  { name: 'helper', kindClass: 'function', range: [110, 120], children: [] },
]

describe('enclosingSymbol', () => {
  it('finds deepest function containing line', () => {
    expect(enclosingSymbol(TREE, 25, 'function'))
      .toEqual({ path: 'AuthService/login', range: [20, 40] })
  })
  it('finds class when asked for class', () => {
    expect(enclosingSymbol(TREE, 25, 'class'))
      .toEqual({ path: 'AuthService', range: [10, 100] })
  })
  it('line inside class but outside methods → no function', () => {
    expect(enclosingSymbol(TREE, 45, 'function')).toBeNull()
  })
  it('top-level function', () => {
    expect(enclosingSymbol(TREE, 115, 'function'))
      .toEqual({ path: 'helper', range: [110, 120] })
  })
  it('no symbol at line', () => {
    expect(enclosingSymbol(TREE, 105, 'function')).toBeNull()
  })
})

describe('resolveSymbolPath', () => {
  it('resolves nested path', () => {
    expect(resolveSymbolPath(TREE, 'AuthService/login')!.range).toEqual([20, 40])
  })
  it('resolves top-level path', () => {
    expect(resolveSymbolPath(TREE, 'helper')!.range).toEqual([110, 120])
  })
  it('missing segment → null', () => {
    expect(resolveSymbolPath(TREE, 'AuthService/nope')).toBeNull()
    expect(resolveSymbolPath(TREE, 'Nope/login')).toBeNull()
  })
})
