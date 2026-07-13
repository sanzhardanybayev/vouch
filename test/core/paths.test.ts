import { describe, it, expect } from 'vitest'
import { authorSlug, isInsideRoot, shardPath, sourcePathOfShard } from '../../src/core/paths'

describe('isInsideRoot', () => {
  it('accepts the root itself and nested paths', () => {
    expect(isInsideRoot('/repo', '/repo')).toBe(true)
    expect(isInsideRoot('/repo', '/repo/src/a.ts')).toBe(true)
  })
  it('rejects a sibling that merely shares the root as a string prefix', () => {
    expect(isInsideRoot('/repo', '/repository/foo')).toBe(false)
  })
  it('rejects parents and unrelated paths', () => {
    expect(isInsideRoot('/repo', '/')).toBe(false)
    expect(isInsideRoot('/repo', '/other')).toBe(false)
  })
})

describe('authorSlug', () => {
  it('is 8 hex chars, case/whitespace-insensitive on email', () => {
    expect(authorSlug('S@X.com ')).toBe(authorSlug('s@x.com'))
    expect(authorSlug('s@x.com')).toMatch(/^[0-9a-f]{8}$/)
  })
  it('differs across emails', () => {
    expect(authorSlug('a@x.com')).not.toBe(authorSlug('b@x.com'))
  })
})

describe('shardPath / sourcePathOfShard', () => {
  it('round-trips', () => {
    const p = shardPath('src/auth/service.ts', 'a1b2c3d4')
    expect(p).toBe('.vouch/reviews/src/auth/service.ts/a1b2c3d4.jsonl')
    expect(sourcePathOfShard(p)).toBe('src/auth/service.ts')
  })
  it('rejects non-shard paths', () => {
    expect(sourcePathOfShard('.vouch/config.json')).toBeNull()
    expect(sourcePathOfShard('src/a.ts')).toBeNull()
  })
  it('accepts windows separators in input', () => {
    expect(sourcePathOfShard('.vouch\\reviews\\src\\a.ts\\a1b2c3d4.jsonl')).toBe('src/a.ts')
  })
  it('rejects traversal, absolute, and degenerate source paths', () => {
    expect(() => shardPath('../evil', 'a1b2c3d4')).toThrow()
    expect(() => shardPath('a/../b', 'a1b2c3d4')).toThrow()
    expect(() => shardPath('/abs/path', 'a1b2c3d4')).toThrow()
    expect(() => shardPath('a//b', 'a1b2c3d4')).toThrow()
    expect(() => shardPath('a/./b', 'a1b2c3d4')).toThrow()
    expect(() => shardPath('C:/evil', 'a1b2c3d4')).toThrow()
    expect(() => shardPath('', 'a1b2c3d4')).toThrow()
  })
})
