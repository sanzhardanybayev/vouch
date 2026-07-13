import { createHash } from 'node:crypto'
import * as path from 'node:path'

// True iff fsPath is root itself or nested under it. Uses path.relative
// rather than a string-prefix check so e.g. root=/repo does not match a
// sibling like /repository.
export function isInsideRoot(root: string, fsPath: string): boolean {
  const rel = path.relative(root, fsPath)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function authorSlug(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 8)
}

export function shardPath(sourcePath: string, slug: string): string {
  if (sourcePath.startsWith('/') || /^[A-Za-z]:/.test(sourcePath)) {
    throw new Error(`shardPath: absolute source path not allowed: ${sourcePath}`)
  }
  for (const seg of sourcePath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`shardPath: invalid source path segment in: ${sourcePath}`)
    }
  }
  return `.vouch/reviews/${sourcePath}/${slug}.jsonl`
}

export function sourcePathOfShard(relPath: string): string | null {
  const m = /^\.vouch\/reviews\/(.+)\/[0-9a-f]{8}\.jsonl$/.exec(relPath.replace(/\\/g, '/'))
  return m ? m[1]! : null
}
