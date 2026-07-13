import { relTime } from './hovermd'

export interface LensEntry {
  authorName: string
  status: 'reviewed' | 'dismissed'
  createdAt: string
}

export function codeLensTitle(entries: LensEntry[], nowIso: string): string {
  if (entries.length === 0) return ''
  if (entries.some(e => e.status === 'dismissed')) {
    return '⚠ Dismissed (changed since review) — re-review'
  }
  const mostRecent = entries.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  const when = relTime(mostRecent.createdAt, nowIso)
  if (entries.length === 1) return `✓ Reviewed by ${mostRecent.authorName}, ${when}`
  return `✓ Reviewed by ${mostRecent.authorName} +${entries.length - 1} more, ${when}`
}
