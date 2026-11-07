import { describe, it, expect } from 'vitest'
import { sniffRustItem } from '../../src/core/rust'
import { enclosingItem, enclosingSymbolOfRange, type SymbolNode } from '../../src/core/anchor'

describe('sniffRustItem', () => {
  it.each([
    ['struct Point { x: i32 }', 'struct'],
    ['pub struct Unit;', 'struct'],
    ['pub(crate) union Bits { a: u32, b: f32 }', 'struct'],
    ['enum Color { Red, Green }', 'enum'],
    ['pub(in crate::a) enum E {}', 'enum'],
    ['trait Shape { fn area(&self) -> f64; }', 'trait'],
    ['pub unsafe trait Send2 {}', 'trait'],
    ['auto trait Marker {}', 'trait'],
    ['impl Point {}', 'impl'],
    ['impl<T: Clone> Shape for Wrapper<T> {}', 'impl'],
    ['unsafe impl Send for Point {}', 'impl'],
    ['default impl<T> Foo for T {}', 'impl'],
    ['mod tests {}', 'mod'],
    ['pub(super) mod inner;', 'mod'],
    ['macro_rules! vec2 { () => {} }', 'macro'],
    ['macro_rules ! spaced { () => {} }', 'macro'],
    ['pub macro m2($x:expr) { $x }', 'macro'],
  ])('%s -> %s', (text, want) => {
    expect(sniffRustItem(text)).toBe(want)
  })

  it.each([
    'fn main() {}',
    'pub async fn run() { struct Local; }',
    'const MAX: usize = 3;',
    'static NAME: &str = "impl";',
    'use std::fmt;',
    'type Alias = Vec<u8>;',
    'let union = 1;',
    'structure()',
    '',
  ])('not an item scope: %s', (text) => {
    expect(sniffRustItem(text)).toBeNull()
  })

  it('skips doc comments, block comments and attributes before the keyword', () => {
    const text = [
      '/// A point.',
      '//! inner doc',
      '/* block /* nested */ still comment */',
      '#[derive(Debug, Clone)]',
      '#[cfg_attr(feature = "serde", serde(rename = "a]b"))]',
      '#![allow(dead_code)]',
      'pub(crate) struct Point {',
      '    x: i32,',
      '}',
    ].join('\n')
    expect(sniffRustItem(text)).toBe('struct')
  })

  it('attributes on test modules', () => {
    expect(sniffRustItem('#[cfg(test)]\nmod tests {\n  use super::*;\n}')).toBe('mod')
  })

  it('extern-qualified items', () => {
    expect(sniffRustItem('extern "C" mod ffi {}')).toBe('mod')
  })

  it('unterminated comment or attribute -> null', () => {
    expect(sniffRustItem('/* never closed struct A {}')).toBeNull()
    expect(sniffRustItem('#[derive(Debug struct A {}')).toBeNull()
  })
})

describe('enclosingItem', () => {
  const node = (
    name: string,
    range: [number, number],
    item?: SymbolNode['item'],
    children: SymbolNode[] = [],
    kindClass: SymbolNode['kindClass'] = 'other',
  ): SymbolNode => ({ name, kindClass, item, range, children })

  const tree: SymbolNode[] = [
    node('outer', [1, 30], 'mod', [
      node('Point', [2, 5], 'struct', [], 'class'),
      node('impl Point', [7, 15], 'impl', [node('new', [8, 10], undefined, [], 'function')]),
      node('inner', [17, 29], 'mod', [node('Shape', [18, 20], 'trait', [], 'class')]),
    ]),
  ]

  it('finds the deepest item of the requested scope', () => {
    expect(enclosingItem(tree, 9, 'impl')).toEqual({ path: 'outer/impl Point', range: [7, 15] })
    expect(enclosingItem(tree, 19, 'mod')?.path).toBe('outer/inner')
    expect(enclosingItem(tree, 9, 'mod')?.path).toBe('outer')
    expect(enclosingItem(tree, 3, 'struct')?.path).toBe('outer/Point')
  })

  it('null when no item of that scope encloses the line', () => {
    expect(enclosingItem(tree, 9, 'trait')).toBeNull()
    expect(enclosingItem(tree, 40, 'mod')).toBeNull()
  })

  it('item tags never change function/class anchoring', () => {
    // impl/mod blocks stay kindClass 'other': selection anchors computed by
    // older clients must keep resolving the same way.
    expect(enclosingSymbolOfRange(tree, [12, 13], 'any')).toBeNull()
    expect(enclosingSymbolOfRange(tree, [9, 9], 'any')?.path).toBe('outer/impl Point/new')
  })
})
