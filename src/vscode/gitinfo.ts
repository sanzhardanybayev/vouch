import { execFile } from 'node:child_process'
import type { Author } from '../core/types'

export function git(args: string[], cwd: string, opts?: { raw?: boolean }): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : opts?.raw ? stdout : stdout.replace(/\n$/, ''))
    })
  })
}

export async function repoRoot(cwd: string): Promise<string | null> {
  return git(['rev-parse', '--show-toplevel'], cwd)
}

export async function identity(cwd: string): Promise<Author | null> {
  const name = await git(['config', 'user.name'], cwd)
  const email = await git(['config', 'user.email'], cwd)
  return name && email ? { name, email } : null
}

export async function headSha(cwd: string): Promise<string | null> {
  return git(['rev-parse', 'HEAD'], cwd)
}

export async function isDirty(root: string, sourcePath: string): Promise<boolean> {
  const out = await git(['status', '--porcelain', '--', sourcePath], root)
  return out !== null && out !== ''
}

export async function showAtCommit(
  root: string, commit: string, sourcePath: string,
): Promise<string | null> {
  // Guard against option injection: commit values from shared .vouch/ records are untrusted
  if (commit.startsWith('-')) return null
  return git(['show', '--end-of-options', `${commit}:${sourcePath}`], root, { raw: true })
}

export async function remoteUrl(root: string): Promise<string | null> {
  return git(['remote', 'get-url', 'origin'], root)
}

export async function lsFiles(root: string): Promise<string[]> {
  const out = await git(['ls-files'], root)
  return out ? out.split('\n').filter(Boolean) : []
}
