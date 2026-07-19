import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ReviewStore } from '../../src/core/store'
import { shardPath, authorSlug } from '../../src/core/paths'
import type { ReviewRecord, Tombstone } from '../../src/core/types'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vouch-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const SAN = { name: 'San', email: 's@x.com' }
const BOB = { name: 'Bob', email: 'b@x.com' }
function rec(id: string, author = SAN, extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id,
    author,
    createdAt: '2026-01-01T00:00:00Z',
    commit: 'c',
    dirty: false,
    kind: 'selection',
    range: [1, 2],
    hash: 'sha256:aa',
    headHash: 'sha256:bb',
    ...extra,
  }
}
async function writeShard(sourcePath: string, email: string, lines: object[]): Promise<void> {
  const p = join(dir, shardPath(sourcePath, authorSlug(email)))
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

describe('ReviewStore', () => {
  it('empty when .vouch missing', async () => {
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.attestedFiles()).toEqual([])
  })

  it('merges shards of multiple authors for one source', async () => {
    await writeShard('src/a.ts', SAN.email, [rec('r1')])
    await writeShard('src/a.ts', BOB.email, [rec('r2', BOB, { range: [5, 6] })])
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.stateFor('src/a.ts')!.current).toHaveLength(2)
    expect(s.attestedFiles()).toEqual(['src/a.ts'])
    expect(s.counts().perAuthor.get(BOB.email)!.current).toBe(1)
  })

  it('cross-shard dedupe by id and revocation apply', async () => {
    const t: Tombstone = {
      id: 't1',
      author: SAN,
      createdAt: '2026-01-02T00:00:00Z',
      revokes: 'r1',
      reason: 'unvouch',
    }
    await writeShard('src/a.ts', SAN.email, [rec('r1'), rec('r1'), t])
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.stateFor('src/a.ts')!.current).toHaveLength(0)
    expect(s.attestedFiles()).toEqual([])
  })

  it('counts corrupt lines without crashing', async () => {
    const p = join(dir, shardPath('src/a.ts', authorSlug(SAN.email)))
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, 'garbage\n' + JSON.stringify(rec('r1')) + '\n', 'utf8')
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.corruptLines).toBe(1)
    expect(s.stateFor('src/a.ts')!.current).toHaveLength(1)
  })

  it('orphans lists attested sources whose file is gone', async () => {
    await writeShard('src/gone.ts', SAN.email, [rec('r1')])
    await writeShard('src/here.ts', SAN.email, [rec('r2')])
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.orphans((p) => p === 'src/here.ts')).toEqual(['src/gone.ts'])
  })
})

describe('perEngineer (v1.1)', () => {
  it('aggregates current records by author across sources', async () => {
    await writeShard('src/a.ts', SAN.email, [rec('r1'), rec('r2', SAN, { range: [5, 6] })])
    await writeShard('src/b.ts', SAN.email, [rec('r3')])
    await writeShard('src/a.ts', BOB.email, [rec('r4', BOB, { range: [9, 10] })])
    const s = new ReviewStore(dir)
    await s.load()
    const eng = s.perEngineer()
    expect(eng.map((e) => e.email)).toEqual([SAN.email, BOB.email]) // San 3 > Bob 1
    const san = eng[0]!
    expect(san.reviewCount).toBe(3)
    expect(san.files).toEqual([
      { sourcePath: 'src/a.ts', count: 2 },
      { sourcePath: 'src/b.ts', count: 1 },
    ])
    expect(eng[1]!).toMatchObject({ email: BOB.email, reviewCount: 1 })
  })

  it('excludes revoked chains', async () => {
    await writeShard('src/a.ts', SAN.email, [
      rec('r1'),
      {
        id: 't1',
        author: SAN,
        createdAt: '2026-01-02T00:00:00Z',
        revokes: 'r1',
        reason: 'unvouch',
      },
    ])
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.perEngineer()).toEqual([])
  })
})

describe('ReviewStore — identity + scoping', () => {
  it('merges case-differing emails into one reviewer identity', async () => {
    const SAN2 = { name: 'San', email: 'S@X.COM' }
    await writeShard('src/a.ts', SAN.email, [rec('r1')])
    await writeShard('src/b.ts', SAN2.email, [rec('r2', SAN2)])
    const s = new ReviewStore(dir)
    await s.load()
    expect(s.perEngineer()).toHaveLength(1)
    expect(s.perEngineer()[0]!.reviewCount).toBe(2)
    expect(s.counts().perAuthor.size).toBe(1)
  })

  it('counts, perEngineer, and orphans honor an includeSourcePath predicate', async () => {
    await writeShard('src/a.ts', SAN.email, [rec('r1')])
    await writeShard('vendor/lib.js', SAN.email, [rec('r2')])
    const s = new ReviewStore(dir)
    await s.load()
    const include = (p: string): boolean => !p.startsWith('vendor/')
    expect(s.counts(include).records).toBe(1)
    expect(s.perEngineer(include)[0]!.reviewCount).toBe(1)
    expect(s.orphans(() => false, include)).toEqual(['src/a.ts'])
  })
})
