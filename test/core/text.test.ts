import { describe, it, expect } from 'vitest'
import { normalizeEol, splitLines, countLines, sha256, hashLines } from '../../src/core/text'

describe('normalizeEol', () => {
  it('converts CRLF to LF, leaves LF alone', () => {
    expect(normalizeEol('a\r\nb\nc')).toBe('a\nb\nc')
  })
})

describe('countLines (coverage convention)', () => {
  it('empty text is 0 lines', () => expect(countLines('')).toBe(0))
  it('trailing newline does not add a line', () => expect(countLines('a\nb\n')).toBe(2))
  it('no trailing newline counts all segments', () => expect(countLines('a\nb\nc')).toBe(3))
  it('single newline only is 1 line', () => expect(countLines('\n')).toBe(1))
  it('CRLF input counts like LF', () => expect(countLines('a\r\nb\r\n')).toBe(2))
})

describe('splitLines (anchoring convention)', () => {
  it('keeps the trailing empty segment', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', ''])
  })
})

describe('hashing', () => {
  it('sha256 has the format prefix', () => {
    expect(sha256('abc')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  it('hashLines equals sha256 of newline-joined lines', () => {
    expect(hashLines(['a', 'b'])).toBe(sha256('a\nb'))
  })
  it('is deterministic', () => {
    expect(sha256('x')).toBe(sha256('x'))
  })
})
