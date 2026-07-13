import { createHash } from 'node:crypto'

export function authorSlug(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 8)
}

export function shardPath(sourcePath: string, slug: string): string {
  return `.vouch/reviews/${sourcePath}/${slug}.jsonl`
}

export function sourcePathOfShard(relPath: string): string | null {
  const m = /^\.vouch\/reviews\/(.+)\/[0-9a-f]{8}\.jsonl$/.exec(relPath.replace(/\\/g, '/'))
  return m ? m[1]! : null
}
