export function commitUrl(remote: string, sha: string): string | null {
  const parsed = parseRemote(remote.trim())
  if (!parsed) return null
  const { host, path } = parsed
  if (host === 'bitbucket.org') return `https://${host}/${path}/commits/${sha}`
  if (host.includes('gitlab')) return `https://${host}/${path}/-/commit/${sha}`
  return `https://${host}/${path}/commit/${sha}` // github + best-effort default
}

function parseRemote(remote: string): { host: string; path: string } | null {
  let m = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote)
  if (m) return { host: m[1]!, path: m[2]! }
  m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote)
  if (m) return { host: m[1]!, path: m[2]! }
  return null
}
