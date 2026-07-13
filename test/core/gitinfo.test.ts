import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { repoRoot, identity, headSha, isDirty, showAtCommit } from '../../src/vscode/gitinfo'

let dir: string
function sh(args: string[]): void { execFileSync('git', args, { cwd: dir }) }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vouch-git-'))
  sh(['init', '-q'])
  sh(['config', 'user.name', 'Test User'])
  sh(['config', 'user.email', 't@x.com'])
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/a.ts'), 'one\ntwo\n')
  sh(['add', '-A']); sh(['commit', '-q', '-m', 'init'])
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('gitinfo', () => {
  it('repoRoot finds the root from a subdirectory', async () => {
    expect(await repoRoot(join(dir, 'src'))).toBe(await repoRoot(dir))
  })
  it('identity reads git config', async () => {
    expect(await identity(dir)).toEqual({ name: 'Test User', email: 't@x.com' })
  })
  it('headSha returns 40 hex', async () => {
    expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/)
  })
  it('isDirty false when clean, true after edit', async () => {
    expect(await isDirty(dir, 'src/a.ts')).toBe(false)
    await writeFile(join(dir, 'src/a.ts'), 'changed\n')
    expect(await isDirty(dir, 'src/a.ts')).toBe(true)
  })
  it('showAtCommit returns committed content; null for bad path', async () => {
    const sha = (await headSha(dir))!
    expect(await showAtCommit(dir, sha, 'src/a.ts')).toBe('one\ntwo\n')
    expect(await showAtCommit(dir, sha, 'src/nope.ts')).toBeNull()
  })
  it('showAtCommit guards against option injection from malicious commit values', async () => {
    // Malicious commit starting with - should return null and not create files
    const result = await showAtCommit(dir, '--output=/tmp/vouch-pwned', 'src/a.ts')
    expect(result).toBeNull()
    // Verify no file was created by git show (git --output would create /tmp/vouch-pwned:src/a.ts)
    expect(existsSync('/tmp/vouch-pwned:src/a.ts')).toBe(false)
  })
  it('null outside a repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vouch-norepo-'))
    try { expect(await repoRoot(outside)).toBeNull() }
    finally { await rm(outside, { recursive: true, force: true }) }
  })
})
