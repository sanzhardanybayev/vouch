import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLine, initVouch } from '../../src/core/writer'
import { parseJsonl } from '../../src/core/records'
import type { ReviewRecord } from '../../src/core/types'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vouch-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const REC: ReviewRecord = {
  id: 'r1', author: { name: 'S', email: 's@x.com' }, createdAt: '2026-01-01T00:00:00Z',
  commit: 'c', dirty: false, kind: 'selection', range: [1, 2],
  hash: 'sha256:aa', headHash: 'sha256:bb',
}

describe('appendLine', () => {
  it('creates directories and appends one JSON line per call', async () => {
    await appendLine(dir, 'src/a.ts', 'a1b2c3d4', REC)
    await appendLine(dir, 'src/a.ts', 'a1b2c3d4', { ...REC, id: 'r2' })
    const content = await readFile(join(dir, '.vouch/reviews/src/a.ts/a1b2c3d4.jsonl'), 'utf8')
    const { lines, corrupt } = parseJsonl(content)
    expect(lines.map(l => l.id)).toEqual(['r1', 'r2'])
    expect(corrupt).toBe(0)
    expect(content.endsWith('\n')).toBe(true)
  })
})

describe('initVouch', () => {
  it('creates config.json and .gitattributes line, idempotently', async () => {
    await initVouch(dir)
    await initVouch(dir)
    const cfg = JSON.parse(await readFile(join(dir, '.vouch/config.json'), 'utf8'))
    expect(cfg.schemaVersion).toBe(1)
    const attrs = await readFile(join(dir, '.gitattributes'), 'utf8')
    expect(attrs.split('\n').filter(l => l === '.vouch/reviews/** merge=union')).toHaveLength(1)
  })
  it('preserves an existing .gitattributes', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, '.gitattributes'), '*.png binary\n')
    await initVouch(dir)
    const attrs = await readFile(join(dir, '.gitattributes'), 'utf8')
    expect(attrs).toContain('*.png binary')
    expect(attrs).toContain('.vouch/reviews/** merge=union')
  })
  it('does not clobber an existing config.json', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const existing = '{"schemaVersion":1,"custom":"x"}'
    await mkdir(join(dir, '.vouch'), { recursive: true })
    await writeFile(join(dir, '.vouch/config.json'), existing)
    await initVouch(dir)
    expect(await readFile(join(dir, '.vouch/config.json'), 'utf8')).toBe(existing)
  })
})
