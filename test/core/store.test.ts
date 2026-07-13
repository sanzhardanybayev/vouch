import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ReviewStore } from '../../src/core/store'
import { shardPath, authorSlug } from '../../src/core/paths'
import type { ReviewRecord, Tombstone } from '../../src/core/types'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vouch-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const SAN = { name: 'San', email: 's@x.com' }
const BOB = { name: 'Bob', email: 'b@x.com' }
function rec(id: string, author = SAN, extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id, author, createdAt: '2026-01-01T00:00:00Z', commit: 'c', dirty: false,
    kind: 'selection', range: [1, 2], hash: 'sha256:aa', headHash: 'sha256:bb', ...extra }
}
async function writeShard(sourcePath: string, email: string, lines: object[]): Promise<void> {
  const p = join(dir, shardPath(sourcePath, authorSlug(email)))
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8')
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
    const t: Tombstone = { id: 't1', author: SAN, createdAt: '2026-01-02T00:00:00Z',
      revokes: 'r1', reason: 'unvouch' }
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
    expect(s.orphans(p => p === 'src/here.ts')).toEqual(['src/gone.ts'])
  })
})
