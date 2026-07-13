import { describe, it, expect } from 'vitest'
import { authorSlug, shardPath, sourcePathOfShard } from '../../src/core/paths'

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
})
