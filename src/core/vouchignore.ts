// .vouchignore: a gitignore-subset matcher deciding which tracked files count
// toward review coverage (the sidebar's universe - tree, denominator, header
// counts, reviewer stats, orphans). Editor surfaces stay unfiltered.
//
// Supported per line: blank lines and # comments; `*` (within a segment),
// `**` (across segments), `?` (one non-slash char); any non-trailing `/`
// anchors the pattern to the repo root (gitignore semantics - only a bare
// name or trailing-slash dir name matches at any depth); a trailing `/`
// matches the directory's whole subtree; a leading `!` re-includes, with
// last-match-wins semantics like gitignore. No runtime dependencies by design.

export interface VouchIgnore {
  ignores(sourcePath: string): boolean
}

const INCLUDE_ALL: VouchIgnore = { ignores: () => false }

function segmentToRegex(seg: string): string {
  let out = ''
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.startsWith('/')
  const dirOnly = pattern.endsWith('/')
  let body = pattern.replace(/^\//, '').replace(/\/$/, '')
  // Only a pattern with no non-trailing separator matches at any depth, like
  // gitignore: `dist` hits `a/b/dist`, but `docs/*.md` is root-anchored.
  const rooted = anchored || body.includes('/')

  // `**` handling: split on '/' and translate segment by segment so `*` and
  // `?` can never cross a directory boundary. The '**' sentinel is '\x00'
  // written as an ESCAPE SEQUENCE - never a raw byte, which would make this
  // file binary to git and invisible in review. NUL cannot appear in a path
  // or a pattern, so the sentinel can never collide with pattern content.
  const parts = body.split('/').map(seg =>
    seg === '**' ? '\x00' : segmentToRegex(seg))
  body = parts.join('/')
    .replace(/\x00\//g, '(?:[^/]+/)*')
    .replace(/\/\x00/g, '(?:/[^/]+)*')
    .replace(/\x00/g, '.*')

  const prefix = rooted ? '^' : '^(?:[^/]+/)*'
  // A directory pattern owns its subtree; a file pattern may also name a
  // directory (gitignore semantics: `dist` ignores the dir and everything in it).
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$'
  return new RegExp(prefix + body + suffix)
}

export function compileVouchIgnore(source: string): VouchIgnore {
  const rules: { negated: boolean; re: RegExp }[] = []
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    const pattern = negated ? line.slice(1) : line
    if (!pattern) continue
    try {
      rules.push({ negated, re: patternToRegex(pattern) })
    } catch {
      // An unparseable pattern is skipped rather than taking the whole file down.
    }
  }
  if (rules.length === 0) return INCLUDE_ALL
  return {
    ignores(sourcePath: string): boolean {
      let ignored = false
      for (const r of rules) {
        if (r.re.test(sourcePath)) ignored = !r.negated
      }
      return ignored
    },
  }
}
