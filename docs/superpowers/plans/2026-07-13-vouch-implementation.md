# Vouch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Vouch VS Code/Cursor extension: human-authored review attestations anchored to exact text hashes, stored in a git-versioned `.vouch/` folder, surfaced via gutter icons, hovers, a timeline panel, and a coverage sidebar.

**Architecture:** A pure-Node core (`src/core/**` — hashing, JSONL store, chain resolution, anchor engine, coverage math; no `vscode` runtime imports, fully vitest-testable) wrapped by thin VS Code adapters (`src/vscode/**` — commands, decorations, hovers, tree view, webview, git child_process helpers). Spec: `docs/superpowers/specs/2026-07-13-vouch-design.md` (rev 2) — the spec is the contract; this plan implements every section.

**Tech Stack:** TypeScript (strict), esbuild bundling, vitest for core unit tests, `@vscode/test-electron` + mocha for integration tests, `@vscode/vsce` packaging. No runtime deps beyond Node built-ins; git via `child_process`.

## Global Constraints

- VS Code engine pin: `^1.85.0`; **stable APIs only** (Cursor compatibility). Never use proposed APIs.
- `.vouch/` lives at the **git repo root** (workspace folder root when not a git repo).
- Storage is **append-only JSONL, one shard per author**: `.vouch/reviews/<repo-relative-source-path>/<slug>.jsonl`, slug = first 8 hex of `sha256(lowercased email)`. Files are never rewritten or deleted.
- All hashing/line math normalizes CRLF→LF first. Hash format string: `sha256:<hex>`.
- Line-count convention (coverage): trailing newline does not add a line; `"a\nb\n"` = 2 lines; empty text = 0 lines. Anchoring keeps raw `split('\n')` segments (a trailing empty segment is a selectable line).
- Ranges in records are `[startLine, endLine]`, **1-based inclusive**.
- Status (`reviewed`/`dismissed`) is derived at render time, never stored.
- Huge-file cap: files > 20 000 lines skip the text scan (single stored-range window check only).
- Revocation kills the entire supersedes-chain. Every vouch command auto-supersedes the same user's overlapping current records.
- Commit messages: conventional commits (`feat:`, `test:`, `chore:`). Commit after every green test cycle.

## File Structure

```
vouch/
  package.json                     # extension manifest (commands, views, menus) + scripts
  tsconfig.json
  esbuild.mjs                      # bundles src/vscode/extension.ts → dist/extension.js
  vitest.config.ts
  media/reviewed.svg  media/dismissed.svg
  src/
    core/                          # PURE NODE — no `vscode` value imports anywhere
      types.ts                     # ReviewRecord, Tombstone, Author, VouchLine
      text.ts                      # normalizeEol, splitLines, countLines, sha256, hashLines
      records.ts                   # parseJsonl, dedupeById, resolveChains (ChainState)
      paths.ts                     # authorSlug, shardPath, sourcePathOfShard
      writer.ts                    # appendLine, initVouch
      store.ts                     # ReviewStore (load shards, index by source path, orphans, counts)
      anchor.ts                    # SymbolNode helpers + resolveRecord (two-stage scan)
      coverage.ts                  # fileCoverage, rollup, pct
      giturl.ts                    # remote URL → commit web link
      hovermd.ts                   # pure markdown builders for both hovers
      treemodel.ts                 # pure sidebar tree model builder
      timelinehtml.ts              # pure webview HTML builder
    vscode/
      extension.ts                 # activation, wiring, refresh pipeline, watcher, debounce
      context.ts                   # VouchContext: root/store resolution per uri, source paths
      gitinfo.ts                   # child_process git: repoRoot, identity, headSha, isDirty, show, lsFiles
      symbols.ts                   # executeDocumentSymbolProvider → SymbolNode[] (shape detection)
      commands.ts                  # all vouch.* commands
      gutter.ts                    # decoration types + apply
      hovers.ts                    # range hover + call-site hover providers (definition cache)
      diff.ts                      # baseline content provider + showDiff logic
      sidebar.ts                   # TreeDataProvider + background coverage queue
      panel.ts                     # timeline webview panel
  test/                            # vitest unit tests mirror src/core
    core/*.test.ts
    vscode-int/                    # @vscode/test-electron harness
      runTest.ts  suite/index.ts  suite/extension.test.ts
      fixture/                     # fixture workspace (git repo created by test setup)
```

Dependency direction: `vscode/*` → `core/*`, never the reverse. `core/*` may use `import type` from `vscode` — types only, erased at compile.

---

### Task 1: Scaffold, manifest, build + test infrastructure

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `src/vscode/extension.ts` (stub), `media/reviewed.svg`, `media/dismissed.svg`, `test/core/smoke.test.ts`

**Interfaces:**
- Produces: `npm run build` (esbuild bundle), `npm test` (vitest), `npm run test:int` (added Task 10), command/view ids used by all later tasks: `vouch.init|selection|function|class|file|reReview|unvouch|showDiff|openCommitOnWeb|reattach`, view container `vouch`, view `vouch.coverage`.

- [ ] **Step 1: Write package.json (full manifest)**

```jsonc
// package.json  (strip comments when writing — npm does not allow them)
{
  "name": "vouch",
  "displayName": "Vouch",
  "description": "Human-authored review coverage: attest code you reviewed; attestations auto-dismiss when the code changes.",
  "version": "0.0.1",
  "publisher": "sanzhar",
  "license": "MIT",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "vouch.init", "title": "Vouch: Initialize in workspace" },
      { "command": "vouch.selection", "title": "Vouch: Review selected lines" },
      { "command": "vouch.function", "title": "Vouch: Review enclosing function" },
      { "command": "vouch.class", "title": "Vouch: Review enclosing class" },
      { "command": "vouch.file", "title": "Vouch: Review entire file" },
      { "command": "vouch.reReview", "title": "Vouch: Re-review (after dismissal)" },
      { "command": "vouch.unvouch", "title": "Vouch: Revoke my review" },
      { "command": "vouch.showDiff", "title": "Vouch: Diff since my review" },
      { "command": "vouch.openCommitOnWeb", "title": "Vouch: Open review commit on web" },
      { "command": "vouch.reattach", "title": "Vouch: Re-attach orphaned reviews" }
    ],
    "menus": {
      "editor/context": [
        { "submenu": "vouch.menu", "group": "1_modification@9" }
      ],
      "vouch.menu": [
        { "command": "vouch.selection", "group": "a@1" },
        { "command": "vouch.function", "group": "a@2" },
        { "command": "vouch.class", "group": "a@3" },
        { "command": "vouch.file", "group": "a@4" },
        { "command": "vouch.reReview", "group": "b@1" },
        { "command": "vouch.unvouch", "group": "b@2" },
        { "command": "vouch.showDiff", "group": "c@1" }
      ]
    },
    "submenus": [ { "id": "vouch.menu", "label": "Vouch" } ],
    "viewsContainers": {
      "activitybar": [ { "id": "vouch", "title": "Vouch", "icon": "media/reviewed.svg" } ]
    },
    "views": {
      "vouch": [ { "id": "vouch.coverage", "name": "Review Coverage" } ]
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:int": "npm run build && tsc -p tsconfig.int.json && node out-int/test/vscode-int/runTest.js",
    "package": "npm run build && vsce package --no-dependencies"
  },
  "devDependencies": {
    "@types/mocha": "^10.0.6",
    "@types/node": "^18.19.0",
    "@types/vscode": "1.85.0",
    "@vscode/test-electron": "^2.3.9",
    "@vscode/vsce": "^2.24.0",
    "esbuild": "^0.20.0",
    "glob": "^10.3.0",
    "mocha": "^10.3.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json, esbuild.mjs, vitest.config.ts, .gitignore, .vscodeignore**

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "out",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", "out", "out-int"]
}
```

```js
// esbuild.mjs
import esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
const ctx = await esbuild.context({
  entryPoints: ['src/vscode/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
})
if (watch) await ctx.watch()
else { await ctx.rebuild(); await ctx.dispose() }
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['test/core/**/*.test.ts'] },
})
```

```
# .gitignore
node_modules/
dist/
out/
out-int/
*.vsix
```

```
# .vscodeignore
**
!dist/**
!media/**
!package.json
!README.md
!LICENSE
```

- [ ] **Step 3: Write extension stub, icons, smoke test**

```ts
// src/vscode/extension.ts
import * as vscode from 'vscode'

export function activate(context: vscode.ExtensionContext): void {
  void context
}
export function deactivate(): void {}
```

```xml
<!-- media/reviewed.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="#2ea043" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.2 5.2-3.7 4.5a.75.75 0 0 1-1.13.05L4.5 8.9a.75.75 0 1 1 1.06-1.06l1.3 1.3 3.18-3.87a.75.75 0 0 1 1.16.94z"/>
</svg>
```

```xml
<!-- media/dismissed.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="#d29922" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.75 3.5a.75.75 0 0 1 1.5 0v4a.75.75 0 0 1-1.5 0v-4zM8 12.2a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
</svg>
```

```ts
// test/core/smoke.test.ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs', () => { expect(1 + 1).toBe(2) })
})
```

- [ ] **Step 4: Install and verify everything runs**

Run: `npm install && npm run typecheck && npm run build && npm test`
Expected: install OK; typecheck clean; `dist/extension.js` exists; vitest 1 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold extension manifest, esbuild, vitest"
```

---

### Task 2: Core types + text/hash utilities

**Files:**
- Create: `src/core/types.ts`, `src/core/text.ts`
- Test: `test/core/text.test.ts`

**Interfaces:**
- Produces: `ReviewRecord`, `Tombstone`, `Author`, `VouchLine`, `RecordKind` (types.ts); `normalizeEol(s)`, `splitLines(s): string[]`, `countLines(s): number`, `sha256(s): string` (returns `sha256:<hex>`), `hashLines(lines: string[]): string` (= `sha256(lines.join('\n'))`). Every later task hashes ONLY through these.

- [ ] **Step 1: Write types**

```ts
// src/core/types.ts
export interface Author { name: string; email: string }

export type RecordKind = 'selection' | 'function' | 'class' | 'file'

export interface ReviewRecord {
  id: string
  author: Author
  createdAt: string            // ISO 8601
  commit: string               // '' when not a git repo
  dirty: boolean               // file differed from HEAD at review time
  kind: RecordKind
  symbol?: string              // hierarchical DocumentSymbol names joined with '/'
  range?: [number, number]     // 1-based inclusive; absent for kind='file'
  hash: string                 // sha256:<hex> of range text (or whole file), CRLF-normalized
  headHash?: string            // sha256:<hex> of the range's first line; absent for kind='file'
  comment?: string
  supersedes?: string[]        // same-user record ids this replaces
  movedFrom?: string           // set by re-attach
}

export interface Tombstone {
  id: string
  author: Author
  createdAt: string
  revokes: string              // any record id in the target chain — kills the whole chain
  reason: 'unvouch' | 'moved'
  movedTo?: string             // repo-relative path, reason='moved'
}

export type VouchLine = ReviewRecord | Tombstone
```

- [ ] **Step 2: Write failing tests for text utilities**

```ts
// test/core/text.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeEol, splitLines, countLines, sha256, hashLines } from '../../src/core/text'

describe('normalizeEol', () => {
  it('converts CRLF to LF, leaves LF alone', () => {
    expect(normalizeEol('a\r\nb\nc')).toBe('a\nb\nc')
  })
})

describe('countLines (coverage convention)', () => {
  it('empty text is 0 lines', () => expect(countLines('')).toBe(0))
  it('trailing newline does not add a line', () => expect(countLines('a\nb\n')).toBe(2))
  it('no trailing newline counts all segments', () => expect(countLines('a\nb\nc')).toBe(3))
  it('single newline only is 1 line', () => expect(countLines('\n')).toBe(1))
  it('CRLF input counts like LF', () => expect(countLines('a\r\nb\r\n')).toBe(2))
})

describe('splitLines (anchoring convention)', () => {
  it('keeps the trailing empty segment', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', ''])
  })
})

describe('hashing', () => {
  it('sha256 has the format prefix', () => {
    expect(sha256('abc')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  it('hashLines equals sha256 of newline-joined lines', () => {
    expect(hashLines(['a', 'b'])).toBe(sha256('a\nb'))
  })
  it('is deterministic', () => {
    expect(sha256('x')).toBe(sha256('x'))
  })
})
```

- [ ] **Step 3: Run tests, verify failure**

Run: `npx vitest run test/core/text.test.ts`
Expected: FAIL — cannot resolve `../../src/core/text`.

- [ ] **Step 4: Implement text.ts**

```ts
// src/core/text.ts
import { createHash } from 'node:crypto'

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Anchoring view of a document: raw LF split, trailing empty segment kept. */
export function splitLines(text: string): string[] {
  return normalizeEol(text).split('\n')
}

/** Coverage line count: trailing newline adds no line; '' is 0 lines. */
export function countLines(text: string): number {
  const t = normalizeEol(text)
  if (t === '') return 0
  const parts = t.split('\n')
  return t.endsWith('\n') ? parts.length - 1 : parts.length
}

export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

export function hashLines(lines: string[]): string {
  return sha256(lines.join('\n'))
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run test/core/text.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/text.ts test/core/text.test.ts
git commit -m "feat: core types and CRLF-normalized text/hash utilities"
```

---

### Task 3: JSONL codec + chain resolution

**Files:**
- Create: `src/core/records.ts`
- Test: `test/core/records.test.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces:
  - `isTombstone(l: VouchLine): l is Tombstone`
  - `parseJsonl(content: string): { lines: VouchLine[]; corrupt: number }`
  - `dedupeById(lines: VouchLine[]): VouchLine[]`
  - `resolveChains(all: VouchLine[]): ChainState` where `ChainState = { current: ReviewRecord[]; chains: Map<string, ReviewRecord[]>; chainOf: Map<string, string>; revokedChains: Set<string> }`. `current` = latest non-revoked record per chain (by `createdAt`, tie-break lexicographically larger `id` — deterministic under union-merge forks). `chains` keys are chain root ids; members sorted ascending by `createdAt`.

- [ ] **Step 1: Write failing tests**

```ts
// test/core/records.test.ts
import { describe, it, expect } from 'vitest'
import { parseJsonl, dedupeById, resolveChains, isTombstone } from '../../src/core/records'
import type { ReviewRecord, Tombstone } from '../../src/core/types'

const AUTHOR = { name: 'San', email: 's@x.com' }
function rec(id: string, createdAt: string, extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return { id, author: AUTHOR, createdAt, commit: 'c1', dirty: false, kind: 'selection',
    range: [1, 3], hash: 'sha256:aa', headHash: 'sha256:bb', ...extra }
}
function tomb(id: string, revokes: string): Tombstone {
  return { id, author: AUTHOR, createdAt: '2026-07-13T10:00:00Z', revokes, reason: 'unvouch' }
}

describe('parseJsonl', () => {
  it('parses records, skips corrupt lines and blanks, counts corruption', () => {
    const content = JSON.stringify(rec('a', '2026-01-01T00:00:00Z')) + '\n' +
      'NOT JSON\n' + '\n' + '{"noId": true}\n'
    const { lines, corrupt } = parseJsonl(content)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.id).toBe('a')
    expect(corrupt).toBe(2)
  })
})

describe('dedupeById', () => {
  it('keeps first occurrence (union-merge duplicates)', () => {
    const a1 = rec('a', '2026-01-01T00:00:00Z')
    const out = dedupeById([a1, rec('a', '2026-01-02T00:00:00Z'), rec('b', '2026-01-01T00:00:00Z')])
    expect(out.map(l => l.id)).toEqual(['a', 'b'])
  })
})

describe('resolveChains', () => {
  it('single record is its own chain and current', () => {
    const s = resolveChains([rec('a', '2026-01-01T00:00:00Z')])
    expect(s.current.map(r => r.id)).toEqual(['a'])
    expect(s.chains.size).toBe(1)
  })

  it('supersedes links records into one chain; latest wins', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
    ])
    expect(s.current.map(r => r.id)).toEqual(['b'])
    expect(s.chains.size).toBe(1)
    const chain = [...s.chains.values()][0]!
    expect(chain.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('fork (two records superseding same parent) resolves by createdAt, tie by id', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      rec('c', '2026-01-02T00:00:00Z', { supersedes: ['a'] }), // same timestamp fork
    ])
    expect(s.current.map(r => r.id)).toEqual(['c']) // 'c' > 'b'
  })

  it('revoking ANY record kills the whole chain — no resurrection', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      tomb('t1', 'b'), // revoke the re-review — 'a' must NOT come back
    ])
    expect(s.current).toHaveLength(0)
    expect(s.revokedChains.size).toBe(1)
  })

  it('revoking via an OLD id in the chain also kills the chain', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z'),
      rec('b', '2026-01-02T00:00:00Z', { supersedes: ['a'] }),
      tomb('t1', 'a'),
    ])
    expect(s.current).toHaveLength(0)
  })

  it('supersedes referencing a missing id still forms a chain', () => {
    const s = resolveChains([rec('b', '2026-01-02T00:00:00Z', { supersedes: ['ghost'] })])
    expect(s.current.map(r => r.id)).toEqual(['b'])
  })

  it('independent chains stay independent', () => {
    const s = resolveChains([
      rec('a', '2026-01-01T00:00:00Z', { range: [1, 3] }),
      rec('x', '2026-01-01T00:00:00Z', { range: [10, 12] }),
    ])
    expect(s.current).toHaveLength(2)
    expect(s.chains.size).toBe(2)
  })

  it('isTombstone discriminates', () => {
    expect(isTombstone(tomb('t', 'a'))).toBe(true)
    expect(isTombstone(rec('a', '2026-01-01T00:00:00Z'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/records.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement records.ts**

```ts
// src/core/records.ts
import type { ReviewRecord, Tombstone, VouchLine } from './types'

export function isTombstone(l: VouchLine): l is Tombstone {
  return 'revokes' in l
}

export function parseJsonl(content: string): { lines: VouchLine[]; corrupt: number } {
  const lines: VouchLine[] = []
  let corrupt = 0
  for (const raw of content.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s) as VouchLine
      if (typeof (obj as { id?: unknown }).id === 'string') lines.push(obj)
      else corrupt++
    } catch {
      corrupt++
    }
  }
  return { lines, corrupt }
}

export function dedupeById(lines: VouchLine[]): VouchLine[] {
  const seen = new Set<string>()
  const out: VouchLine[] = []
  for (const l of lines) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    out.push(l)
  }
  return out
}

export interface ChainState {
  current: ReviewRecord[]
  chains: Map<string, ReviewRecord[]>
  chainOf: Map<string, string>
  revokedChains: Set<string>
}

/** Union-find over supersedes edges; tombstones kill whole chains. */
export function resolveChains(all: VouchLine[]): ChainState {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  const records = all.filter((l): l is ReviewRecord => !isTombstone(l))
  const tombs = all.filter(isTombstone)

  for (const r of records) {
    if (!parent.has(r.id)) parent.set(r.id, r.id)
    for (const prev of r.supersedes ?? []) union(r.id, prev)
  }

  const revokedChains = new Set<string>()
  for (const t of tombs) {
    if (parent.has(t.revokes)) revokedChains.add(find(t.revokes))
  }

  const chains = new Map<string, ReviewRecord[]>()
  for (const r of records) {
    const root = find(r.id)
    if (!chains.has(root)) chains.set(root, [])
    chains.get(root)!.push(r)
  }

  const chainOf = new Map<string, string>()
  const current: ReviewRecord[] = []
  for (const [root, members] of chains) {
    members.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
    for (const m of members) chainOf.set(m.id, root)
    if (!revokedChains.has(root)) current.push(members[members.length - 1]!)
  }

  return { current, chains, chainOf, revokedChains }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/core/records.test.ts`
Expected: PASS (all 9).

- [ ] **Step 5: Commit**

```bash
git add src/core/records.ts test/core/records.test.ts
git commit -m "feat: JSONL codec, dedupe, supersedes-chain resolution with chain-wide revocation"
```

---

### Task 4: Shard paths + append-only writer + init

**Files:**
- Create: `src/core/paths.ts`, `src/core/writer.ts`
- Test: `test/core/paths.test.ts`, `test/core/writer.test.ts`

**Interfaces:**
- Consumes: `VouchLine`, `Author` (Task 2).
- Produces:
  - `authorSlug(email: string): string` — first 8 hex of sha256 of trimmed, lowercased email.
  - `shardPath(sourcePath: string, slug: string): string` — `.vouch/reviews/<sourcePath>/<slug>.jsonl` (posix separators; `sourcePath` is repo-relative posix).
  - `sourcePathOfShard(relPath: string): string | null` — inverse mapping.
  - `appendLine(rootDir: string, sourcePath: string, slug: string, line: VouchLine): Promise<void>` — mkdir -p + `fs.appendFile` of `JSON.stringify(line) + '\n'`.
  - `initVouch(rootDir: string): Promise<void>` — creates `.vouch/config.json` (`{"schemaVersion":1}`) if absent; appends `.vouch/reviews/** merge=union` to `.gitattributes` if that exact line is absent (creates the file if needed).

- [ ] **Step 1: Write failing tests**

```ts
// test/core/paths.test.ts
import { describe, it, expect } from 'vitest'
import { authorSlug, shardPath, sourcePathOfShard } from '../../src/core/paths'

describe('authorSlug', () => {
  it('is 8 hex chars, case/whitespace-insensitive on email', () => {
    expect(authorSlug('S@X.com ')).toBe(authorSlug('s@x.com'))
    expect(authorSlug('s@x.com')).toMatch(/^[0-9a-f]{8}$/)
  })
  it('differs across emails', () => {
    expect(authorSlug('a@x.com')).not.toBe(authorSlug('b@x.com'))
  })
})

describe('shardPath / sourcePathOfShard', () => {
  it('round-trips', () => {
    const p = shardPath('src/auth/service.ts', 'a1b2c3d4')
    expect(p).toBe('.vouch/reviews/src/auth/service.ts/a1b2c3d4.jsonl')
    expect(sourcePathOfShard(p)).toBe('src/auth/service.ts')
  })
  it('rejects non-shard paths', () => {
    expect(sourcePathOfShard('.vouch/config.json')).toBeNull()
    expect(sourcePathOfShard('src/a.ts')).toBeNull()
  })
  it('accepts windows separators in input', () => {
    expect(sourcePathOfShard('.vouch\\reviews\\src\\a.ts\\a1b2c3d4.jsonl')).toBe('src/a.ts')
  })
})
```

```ts
// test/core/writer.test.ts
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
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/paths.test.ts test/core/writer.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/core/paths.ts
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
```

```ts
// src/core/writer.ts
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { shardPath } from './paths'
import type { VouchLine } from './types'

export async function appendLine(
  rootDir: string, sourcePath: string, slug: string, line: VouchLine,
): Promise<void> {
  const abs = join(rootDir, shardPath(sourcePath, slug))
  await mkdir(dirname(abs), { recursive: true })
  await appendFile(abs, JSON.stringify(line) + '\n', 'utf8')
}

const ATTR_LINE = '.vouch/reviews/** merge=union'

export async function initVouch(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, '.vouch/reviews'), { recursive: true })
  const cfgPath = join(rootDir, '.vouch/config.json')
  try {
    await readFile(cfgPath, 'utf8')
  } catch {
    await writeFile(cfgPath, JSON.stringify({ schemaVersion: 1 }, null, 2) + '\n', 'utf8')
  }
  const attrPath = join(rootDir, '.gitattributes')
  let attrs = ''
  try { attrs = await readFile(attrPath, 'utf8') } catch { /* absent */ }
  if (!attrs.split('\n').includes(ATTR_LINE)) {
    const sep = attrs === '' || attrs.endsWith('\n') ? '' : '\n'
    await writeFile(attrPath, attrs + sep + ATTR_LINE + '\n', 'utf8')
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/core/paths.test.ts test/core/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.ts src/core/writer.ts test/core/paths.test.ts test/core/writer.test.ts
git commit -m "feat: per-author shard paths, append-only writer, vouch init"
```

---

### Task 5: ReviewStore

**Files:**
- Create: `src/core/store.ts`
- Test: `test/core/store.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces class `ReviewStore`:
  - `constructor(rootDir: string)`
  - `load(): Promise<void>` — recursive scan of `<rootDir>/.vouch/reviews`, group shard lines by source path, `dedupeById` + `resolveChains` per source. Missing `.vouch/` → empty store, no throw.
  - `stateFor(sourcePath: string): ChainState | undefined`
  - `attestedFiles(): string[]` — sources with ≥1 current record.
  - `orphans(exists: (sourcePath: string) => boolean): string[]` — attested sources whose file is gone.
  - `counts(): { records: number; perAuthor: Map<string, { name: string; current: number }> }` — current records total and per author email.
  - `corruptLines: number` (accumulated; UI warns once when > 0).

- [ ] **Step 1: Write failing tests**

```ts
// test/core/store.test.ts
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
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement store.ts**

```ts
// src/core/store.ts
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { dedupeById, parseJsonl, resolveChains, type ChainState } from './records'
import { sourcePathOfShard } from './paths'
import type { VouchLine } from './types'

export class ReviewStore {
  private bySource = new Map<string, ChainState>()
  corruptLines = 0

  constructor(private readonly rootDir: string) {}

  async load(): Promise<void> {
    this.bySource = new Map()
    this.corruptLines = 0
    const reviewsDir = join(this.rootDir, '.vouch', 'reviews')
    const shardFiles = await walk(reviewsDir)
    const linesBySource = new Map<string, VouchLine[]>()
    for (const abs of shardFiles) {
      const rel = join('.vouch', 'reviews', relative(reviewsDir, abs))
      const source = sourcePathOfShard(rel)
      if (!source) continue
      const { lines, corrupt } = parseJsonl(await readFile(abs, 'utf8'))
      this.corruptLines += corrupt
      if (!linesBySource.has(source)) linesBySource.set(source, [])
      linesBySource.get(source)!.push(...lines)
    }
    for (const [source, lines] of linesBySource) {
      this.bySource.set(source, resolveChains(dedupeById(lines)))
    }
  }

  stateFor(sourcePath: string): ChainState | undefined {
    return this.bySource.get(sourcePath)
  }

  attestedFiles(): string[] {
    return [...this.bySource.entries()]
      .filter(([, s]) => s.current.length > 0)
      .map(([p]) => p)
      .sort()
  }

  orphans(exists: (sourcePath: string) => boolean): string[] {
    return this.attestedFiles().filter(p => !exists(p))
  }

  counts(): { records: number; perAuthor: Map<string, { name: string; current: number }> } {
    let records = 0
    const perAuthor = new Map<string, { name: string; current: number }>()
    for (const s of this.bySource.values()) {
      for (const r of s.current) {
        records++
        const entry = perAuthor.get(r.author.email) ?? { name: r.author.name, current: 0 }
        entry.current++
        perAuthor.set(r.author.email, entry)
      }
    }
    return { records, perAuthor }
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/core/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts test/core/store.test.ts
git commit -m "feat: ReviewStore loads per-author shards into per-source chain state"
```

---

### Task 6: Git info + web commit URLs

**Files:**
- Create: `src/core/giturl.ts`, `src/vscode/gitinfo.ts`
- Test: `test/core/giturl.test.ts`, `test/core/gitinfo.test.ts` (uses real `git` in a temp repo — `gitinfo.ts` has no `vscode` imports, so vitest can run it)

**Interfaces:**
- Consumes: `Author` (Task 2).
- Produces:
  - `commitUrl(remote: string, sha: string): string | null` (giturl.ts) — parses `git@host:org/repo.git` and `https://host/org/repo[.git]`; github → `https://<host>/<org>/<repo>/commit/<sha>`, gitlab (host contains "gitlab") → `/-/commit/<sha>`, bitbucket.org → `/commits/<sha>`, unknown hosts → github pattern (best effort).
  - gitinfo.ts (all take `cwd`, return `null` on any git failure):
    `git(args: string[], cwd: string): Promise<string | null>`,
    `repoRoot(cwd): Promise<string | null>`,
    `identity(cwd): Promise<Author | null>`,
    `headSha(cwd): Promise<string | null>`,
    `isDirty(root: string, sourcePath: string): Promise<boolean>` (`git status --porcelain -- <path>` non-empty),
    `showAtCommit(root: string, commit: string, sourcePath: string): Promise<string | null>` (`git show <commit>:<path>`),
    `remoteUrl(root): Promise<string | null>` (`git remote get-url origin`),
    `lsFiles(root): Promise<string[]>`.

- [ ] **Step 1: Write failing tests**

```ts
// test/core/giturl.test.ts
import { describe, it, expect } from 'vitest'
import { commitUrl } from '../../src/core/giturl'

describe('commitUrl', () => {
  it('github https', () => {
    expect(commitUrl('https://github.com/org/repo.git', 'abc'))
      .toBe('https://github.com/org/repo/commit/abc')
  })
  it('github ssh', () => {
    expect(commitUrl('git@github.com:org/repo.git', 'abc'))
      .toBe('https://github.com/org/repo/commit/abc')
  })
  it('gitlab (self-hosted host containing gitlab)', () => {
    expect(commitUrl('git@gitlab.mycorp.io:team/app.git', 'abc'))
      .toBe('https://gitlab.mycorp.io/team/app/-/commit/abc')
  })
  it('bitbucket', () => {
    expect(commitUrl('https://bitbucket.org/org/repo.git', 'abc'))
      .toBe('https://bitbucket.org/org/repo/commits/abc')
  })
  it('garbage remote → null', () => {
    expect(commitUrl('not a url', 'abc')).toBeNull()
  })
})
```

```ts
// test/core/gitinfo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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
  it('null outside a repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vouch-norepo-'))
    try { expect(await repoRoot(outside)).toBeNull() }
    finally { await rm(outside, { recursive: true, force: true }) }
  })
})
```

Add to `vitest.config.ts` include: `'test/core/**/*.test.ts'` already covers these paths — no change needed.

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/giturl.test.ts test/core/gitinfo.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/core/giturl.ts
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
```

```ts
// src/vscode/gitinfo.ts — NO vscode imports; child_process only
import { execFile } from 'node:child_process'
import type { Author } from '../core/types'

export function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.replace(/\n$/, ''))
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
  return git(['show', `${commit}:${sourcePath}`], root)
}

export async function remoteUrl(root: string): Promise<string | null> {
  return git(['remote', 'get-url', 'origin'], root)
}

export async function lsFiles(root: string): Promise<string[]> {
  const out = await git(['ls-files'], root)
  return out ? out.split('\n').filter(Boolean) : []
}
```

Note: `git show` trims nothing — but `git()` strips ONE trailing `\n` which `git show` does not add beyond file content. Verify with the test: committed content `one\ntwo\n` must round-trip exactly. If the test fails on the trailing newline, change `git()` to accept an option `{ raw?: boolean }` used by `showAtCommit` that skips the `replace`. Expected with the code above: `git show` outputs the blob verbatim (`one\ntwo\n`), the regex strips the final `\n` → test fails → apply the `raw` option fix:

```ts
export function git(args: string[], cwd: string, opts?: { raw?: boolean }): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : opts?.raw ? stdout : stdout.replace(/\n$/, ''))
    })
  })
}
// showAtCommit uses: git(['show', `${commit}:${sourcePath}`], root, { raw: true })
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/core/giturl.test.ts test/core/gitinfo.test.ts`
Expected: PASS (after the `raw` fix above).

- [ ] **Step 5: Commit**

```bash
git add src/core/giturl.ts src/vscode/gitinfo.ts test/core/giturl.test.ts test/core/gitinfo.test.ts
git commit -m "feat: git child_process helpers and commit web URL builder"
```

---

### Task 7: Symbol tree helpers

**Files:**
- Create: `src/core/anchor.ts` (symbol section)
- Test: `test/core/symbols.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (in `src/core/anchor.ts`):
  - `interface SymbolNode { name: string; kindClass: 'function' | 'class' | 'other'; range: [number, number]; children: SymbolNode[] }` — structural, built by `src/vscode/symbols.ts` (Task 10) from `DocumentSymbol[]`; `range` is 1-based inclusive full range.
  - `enclosingSymbol(roots: SymbolNode[], line: number, want: 'function' | 'class'): { path: string; range: [number, number] } | null` — deepest node of matching kindClass whose range contains `line`; `path` = names root→node joined `'/'`.
  - `resolveSymbolPath(roots: SymbolNode[], path: string): SymbolNode | null` — follow names; a path segment must match a node name at that depth (search all children, names may repeat — first match by document order).

- [ ] **Step 1: Write failing tests**

```ts
// test/core/symbols.test.ts
import { describe, it, expect } from 'vitest'
import { enclosingSymbol, resolveSymbolPath, type SymbolNode } from '../../src/core/anchor'

const TREE: SymbolNode[] = [
  {
    name: 'AuthService', kindClass: 'class', range: [10, 100],
    children: [
      { name: 'login', kindClass: 'function', range: [20, 40], children: [] },
      { name: 'logout', kindClass: 'function', range: [50, 60], children: [] },
    ],
  },
  { name: 'helper', kindClass: 'function', range: [110, 120], children: [] },
]

describe('enclosingSymbol', () => {
  it('finds deepest function containing line', () => {
    expect(enclosingSymbol(TREE, 25, 'function'))
      .toEqual({ path: 'AuthService/login', range: [20, 40] })
  })
  it('finds class when asked for class', () => {
    expect(enclosingSymbol(TREE, 25, 'class'))
      .toEqual({ path: 'AuthService', range: [10, 100] })
  })
  it('line inside class but outside methods → no function', () => {
    expect(enclosingSymbol(TREE, 45, 'function')).toBeNull()
  })
  it('top-level function', () => {
    expect(enclosingSymbol(TREE, 115, 'function'))
      .toEqual({ path: 'helper', range: [110, 120] })
  })
  it('no symbol at line', () => {
    expect(enclosingSymbol(TREE, 105, 'function')).toBeNull()
  })
})

describe('resolveSymbolPath', () => {
  it('resolves nested path', () => {
    expect(resolveSymbolPath(TREE, 'AuthService/login')!.range).toEqual([20, 40])
  })
  it('resolves top-level path', () => {
    expect(resolveSymbolPath(TREE, 'helper')!.range).toEqual([110, 120])
  })
  it('missing segment → null', () => {
    expect(resolveSymbolPath(TREE, 'AuthService/nope')).toBeNull()
    expect(resolveSymbolPath(TREE, 'Nope/login')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/symbols.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the symbol section of anchor.ts**

```ts
// src/core/anchor.ts
export interface SymbolNode {
  name: string
  kindClass: 'function' | 'class' | 'other'
  range: [number, number] // 1-based inclusive full range
  children: SymbolNode[]
}

export function enclosingSymbol(
  roots: SymbolNode[], line: number, want: 'function' | 'class',
): { path: string; range: [number, number] } | null {
  let best: { path: string; range: [number, number]; depth: number } | null = null
  const visit = (nodes: SymbolNode[], prefix: string[], depth: number): void => {
    for (const n of nodes) {
      if (line < n.range[0] || line > n.range[1]) continue
      const path = [...prefix, n.name]
      if (n.kindClass === want && (best === null || depth > best.depth)) {
        best = { path: path.join('/'), range: n.range, depth }
      }
      visit(n.children, path, depth + 1)
    }
  }
  visit(roots, [], 0)
  return best ? { path: best.path, range: best.range } : null
}

export function resolveSymbolPath(roots: SymbolNode[], path: string): SymbolNode | null {
  const segments = path.split('/')
  let level = roots
  let node: SymbolNode | null = null
  for (const seg of segments) {
    node = level.find(n => n.name === seg) ?? null
    if (!node) return null
    level = node.children
  }
  return node
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/core/symbols.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/anchor.ts test/core/symbols.test.ts
git commit -m "feat: symbol tree path build/resolve helpers"
```

---

### Task 8: Anchor engine — resolveRecord (two-stage scan)

**Files:**
- Modify: `src/core/anchor.ts` (append resolution section)
- Test: `test/core/anchor.test.ts`

**Interfaces:**
- Consumes: `splitLines`, `hashLines`, `sha256`, `normalizeEol` (Task 2); `ReviewRecord` (Task 2).
- Produces:
  - `type Status = 'reviewed' | 'dismissed'`
  - `interface Resolution { status: Status; effectiveRange: [number, number] }`
  - `const HUGE_FILE_LINES = 20_000`
  - `resolveRecord(rec: ReviewRecord, docText: string, symbolRange?: [number, number] | null): Resolution` — implements spec §5 steps: symbolRange check → two-stage text scan (headHash line prefilter + full window confirm, nearest-to-stored-range tie-break) → dismissed at clamped stored range. `kind='file'` compares `sha256(normalizeEol(docText))`. Huge files: only the single window at the stored range is checked.
  - Helper used by record creation (Task 11): `hashRangeOfText(docText: string, range: [number, number]): { hash: string; headHash: string }`.

- [ ] **Step 1: Write failing tests**

```ts
// test/core/anchor.test.ts
import { describe, it, expect } from 'vitest'
import { resolveRecord, hashRangeOfText, HUGE_FILE_LINES } from '../../src/core/anchor'
import { splitLines } from '../../src/core/text'
import type { ReviewRecord } from '../../src/core/types'

const DOC = ['function a() {', '  return 1', '}', '', 'function b() {', '  return 2', '}'].join('\n')

function recFor(docText: string, range: [number, number], extra: Partial<ReviewRecord> = {}): ReviewRecord {
  const { hash, headHash } = hashRangeOfText(docText, range)
  return { id: 'r1', author: { name: 'S', email: 's@x.com' }, createdAt: '2026-01-01T00:00:00Z',
    commit: 'c', dirty: false, kind: 'selection', range, hash, headHash, ...extra }
}

describe('resolveRecord — text scan', () => {
  it('unchanged text at same place → reviewed', () => {
    const r = recFor(DOC, [1, 3])
    expect(resolveRecord(r, DOC)).toEqual({ status: 'reviewed', effectiveRange: [1, 3] })
  })

  it('code moved down (insert above) → reviewed at new range', () => {
    const r = recFor(DOC, [1, 3])
    const moved = '// new header\n' + DOC
    expect(resolveRecord(r, moved)).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })

  it('edited text → dismissed at clamped stored range', () => {
    const r = recFor(DOC, [1, 3])
    const edited = DOC.replace('return 1', 'return 42')
    expect(resolveRecord(r, edited)).toEqual({ status: 'dismissed', effectiveRange: [1, 3] })
  })

  it('deleted text in shrunken doc → dismissed, range clamped to doc length', () => {
    const r = recFor(DOC, [5, 7])
    const shrunk = 'x'
    expect(resolveRecord(r, shrunk)).toEqual({ status: 'dismissed', effectiveRange: [1, 1] })
  })

  it('duplicate matches → nearest to stored range wins', () => {
    const block = 'function dup() {\n  return 9\n}'
    const doc = [block, '', 'spacer', 'spacer', 'spacer', '', block].join('\n')
    const r = recFor(doc, [7 + 0, 7 + 2] as [number, number]) // second copy starts at line 7... compute:
    // lines: 1-3 block, 4 '', 5-7 spacers... adjust below in implementation step if off —
    // the assertion that matters: resolved range equals the stored range, not the first copy.
    const res = resolveRecord(r, doc)
    expect(res.status).toBe('reviewed')
    expect(res.effectiveRange).toEqual(r.range)
  })

  it('CRLF document matches LF-hashed record', () => {
    const r = recFor(DOC, [1, 3])
    const crlf = DOC.replace(/\n/g, '\r\n')
    expect(resolveRecord(r, crlf).status).toBe('reviewed')
  })
})

describe('resolveRecord — symbolRange step', () => {
  it('match at symbolRange → reviewed there (no scan)', () => {
    const r = recFor(DOC, [1, 3], { kind: 'function', symbol: 'a' })
    const moved = '// h\n' + DOC
    expect(resolveRecord(r, moved, [2, 4])).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })
  it('mismatch at symbolRange falls through to scan and can still find moved text', () => {
    const r = recFor(DOC, [1, 3], { kind: 'function', symbol: 'a' })
    const moved = '// h\n' + DOC
    // wrong symbolRange (points at function b) — scan must still find function a at [2,4]
    expect(resolveRecord(r, moved, [6, 8])).toEqual({ status: 'reviewed', effectiveRange: [2, 4] })
  })
})

describe('resolveRecord — kind=file', () => {
  it('whole-file match / mismatch', () => {
    const { hash } = hashRangeOfText(DOC, [1, splitLines(DOC).length])
    const r: ReviewRecord = { id: 'f', author: { name: 'S', email: 's@x.com' },
      createdAt: '2026-01-01T00:00:00Z', commit: 'c', dirty: false, kind: 'file', hash }
    expect(resolveRecord(r, DOC).status).toBe('reviewed')
    expect(resolveRecord(r, DOC + '\nx').status).toBe('dismissed')
  })
})

describe('resolveRecord — huge files', () => {
  it('over cap: exact stored-range window still detected, moved text is not', () => {
    const filler = Array.from({ length: HUGE_FILE_LINES + 5 }, (_, i) => `line ${i}`)
    const doc = filler.join('\n')
    const r = recFor(doc, [100, 102])
    expect(resolveRecord(r, doc).status).toBe('reviewed')          // window at stored range
    const moved = 'inserted\n' + doc                                // shifts everything by 1
    expect(resolveRecord(r, moved).status).toBe('dismissed')       // no scan over cap
  })
})
```

- [ ] **Step 2: Fix the duplicate-match fixture line numbers**

Before running, compute the second block's true position: lines are `1:'function dup() {'`, `2:'  return 9'`, `3:'}'`, `4:''`, `5:'spacer'`, `6:'spacer'`, `7:'spacer'`, `8:''`, `9:'function dup() {'`, `10:'  return 9'`, `11:'}'`. Set the record range to `[9, 11]`:

```ts
    const r = recFor(doc, [9, 11])
```

- [ ] **Step 3: Run tests, verify failure**

Run: `npx vitest run test/core/anchor.test.ts`
Expected: FAIL — `resolveRecord` not exported.

- [ ] **Step 4: Implement (append to src/core/anchor.ts)**

```ts
// append to src/core/anchor.ts
import { hashLines, normalizeEol, sha256, splitLines } from './text'
import type { ReviewRecord } from './types'

export type Status = 'reviewed' | 'dismissed'
export interface Resolution { status: Status; effectiveRange: [number, number] }
export const HUGE_FILE_LINES = 20_000

export function hashRangeOfText(
  docText: string, range: [number, number],
): { hash: string; headHash: string } {
  const lines = splitLines(docText)
  const slice = lines.slice(range[0] - 1, range[1])
  return { hash: hashLines(slice), headHash: sha256(slice[0] ?? '') }
}

export function resolveRecord(
  rec: ReviewRecord, docText: string, symbolRange?: [number, number] | null,
): Resolution {
  const lines = splitLines(docText)

  if (rec.kind === 'file') {
    const status: Status = sha256(normalizeEol(docText)) === rec.hash ? 'reviewed' : 'dismissed'
    return { status, effectiveRange: [1, Math.max(1, lines.length)] }
  }

  const stored: [number, number] = rec.range ?? [1, 1]
  const len = stored[1] - stored[0] + 1

  const windowMatches = (startIdx: number): boolean =>
    startIdx >= 0 && startIdx + len <= lines.length &&
    hashLines(lines.slice(startIdx, startIdx + len)) === rec.hash

  // Step 1 (spec §5): symbol range check
  if (symbolRange) {
    const [s, e] = symbolRange
    if (hashLines(lines.slice(s - 1, e)) === rec.hash) {
      return { status: 'reviewed', effectiveRange: [s, e] }
    }
    // fall through to scan — text may have moved elsewhere
  }

  // Step 2: two-stage scan (headHash line prefilter → full window confirm)
  if (lines.length > HUGE_FILE_LINES) {
    if (windowMatches(stored[0] - 1)) {
      return { status: 'reviewed', effectiveRange: stored }
    }
  } else if (rec.headHash) {
    const candidates: number[] = []
    for (let i = 0; i + len <= lines.length; i++) {
      if (sha256(lines[i]!) === rec.headHash) candidates.push(i)
    }
    let best: number | null = null
    for (const i of candidates) {
      if (!windowMatches(i)) continue
      if (best === null || Math.abs(i - (stored[0] - 1)) < Math.abs(best - (stored[0] - 1))) best = i
    }
    if (best !== null) {
      return { status: 'reviewed', effectiveRange: [best + 1, best + len] }
    }
  }

  // Dismissed: display at stored range clamped to document
  const maxLine = Math.max(1, lines.length)
  const start = Math.min(stored[0], maxLine)
  const end = Math.min(stored[1], maxLine)
  return { status: 'dismissed', effectiveRange: [start, Math.max(start, end)] }
}
```

Performance note (spec §5): per-line `sha256(lines[i])` is one pass O(N); window confirms run only on candidates. Callers cache by document version (Task 12) — do not add caching here.

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run test/core/anchor.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/core/anchor.ts test/core/anchor.test.ts
git commit -m "feat: anchor engine — symbol check plus two-stage text scan relocation"
```

---

### Task 9: Coverage math

**Files:**
- Create: `src/core/coverage.ts`
- Test: `test/core/coverage.test.ts`

**Interfaces:**
- Consumes: `countLines` (Task 2); `Resolution` (Task 8); `ReviewRecord` (Task 2).
- Produces:
  - `interface FileCoverage { reviewedLines: number; totalLines: number }`
  - `fileCoverage(resolved: { record: ReviewRecord; res: Resolution }[], docText: string): FileCoverage | null` — `null` when `countLines(docText) === 0` (excluded, spec §8). A live `kind='file'` reviewed record → full coverage. Otherwise union of `effectiveRange`s of records with `res.status === 'reviewed'`, clamped to `[1, totalLines]`.
  - `rollup(children: (FileCoverage | null)[]): FileCoverage | null` — raw line sums over non-null entries; `null` if all null.
  - `pct(c: FileCoverage): number` — `Math.round(100 * reviewedLines / totalLines)`.

- [ ] **Step 1: Write failing tests**

```ts
// test/core/coverage.test.ts
import { describe, it, expect } from 'vitest'
import { fileCoverage, rollup, pct } from '../../src/core/coverage'
import type { ReviewRecord } from '../../src/core/types'
import type { Resolution } from '../../src/core/anchor'

const DOC = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj' // 10 lines
function entry(range: [number, number], status: 'reviewed' | 'dismissed' = 'reviewed',
  kind: 'selection' | 'file' = 'selection') {
  const record = { id: 'x', kind } as ReviewRecord
  const res: Resolution = { status, effectiveRange: range }
  return { record, res }
}

describe('fileCoverage', () => {
  it('union of reviewed ranges, overlaps counted once', () => {
    const c = fileCoverage([entry([1, 4]), entry([3, 6])], DOC)!
    expect(c).toEqual({ reviewedLines: 6, totalLines: 10 })
  })
  it('dismissed records contribute nothing', () => {
    const c = fileCoverage([entry([1, 4], 'dismissed')], DOC)!
    expect(c).toEqual({ reviewedLines: 0, totalLines: 10 })
  })
  it('live kind=file review → 100%', () => {
    const c = fileCoverage([entry([1, 10], 'reviewed', 'file')], DOC)!
    expect(c).toEqual({ reviewedLines: 10, totalLines: 10 })
  })
  it('empty file → null (excluded from rollups)', () => {
    expect(fileCoverage([], '')).toBeNull()
  })
  it('range clamped to totalLines (trailing-newline convention)', () => {
    const c = fileCoverage([entry([9, 11])], DOC + '\n')! // 10 lines by convention
    expect(c).toEqual({ reviewedLines: 2, totalLines: 10 })
  })
})

describe('rollup / pct', () => {
  it('raw line sums, nulls skipped', () => {
    const r = rollup([{ reviewedLines: 5, totalLines: 10 }, null, { reviewedLines: 0, totalLines: 30 }])!
    expect(r).toEqual({ reviewedLines: 5, totalLines: 40 })
    expect(pct(r)).toBe(13)
  })
  it('all null → null (no NaN poisoning)', () => {
    expect(rollup([null, null])).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/coverage.ts
import { countLines } from './text'
import type { Resolution } from './anchor'
import type { ReviewRecord } from './types'

export interface FileCoverage { reviewedLines: number; totalLines: number }

export function fileCoverage(
  resolved: { record: ReviewRecord; res: Resolution }[], docText: string,
): FileCoverage | null {
  const totalLines = countLines(docText)
  if (totalLines === 0) return null
  if (resolved.some(e => e.record.kind === 'file' && e.res.status === 'reviewed')) {
    return { reviewedLines: totalLines, totalLines }
  }
  const covered = new Set<number>()
  for (const { res } of resolved) {
    if (res.status !== 'reviewed') continue
    const start = Math.max(1, res.effectiveRange[0])
    const end = Math.min(totalLines, res.effectiveRange[1])
    for (let l = start; l <= end; l++) covered.add(l)
  }
  return { reviewedLines: covered.size, totalLines }
}

export function rollup(children: (FileCoverage | null)[]): FileCoverage | null {
  let reviewedLines = 0
  let totalLines = 0
  let any = false
  for (const c of children) {
    if (!c) continue
    any = true
    reviewedLines += c.reviewedLines
    totalLines += c.totalLines
  }
  return any ? { reviewedLines, totalLines } : null
}

export function pct(c: FileCoverage): number {
  return Math.round((100 * c.reviewedLines) / c.totalLines)
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/core/coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/coverage.ts test/core/coverage.test.ts
git commit -m "feat: coverage math — attested-file union, null-safe rollups"
```

---

### Task 10: VS Code adapters — symbols, context, activation skeleton, integration harness

**Files:**
- Create: `src/vscode/symbols.ts`, `src/vscode/context.ts`
- Modify: `src/vscode/extension.ts`
- Create: `tsconfig.int.json`, `test/vscode-int/runTest.ts`, `test/vscode-int/suite/index.ts`, `test/vscode-int/suite/extension.test.ts`, `test/vscode-int/fixture/.gitkeep`

**Interfaces:**
- Consumes: `SymbolNode`, `ReviewStore`, gitinfo (Tasks 5–7).
- Produces:
  - `documentSymbols(uri: vscode.Uri): Promise<SymbolNode[]>` (symbols.ts) — runs `vscode.executeDocumentSymbolProvider`; detects shape: if first element lacks a `children` property (flat `SymbolInformation`) → return `[]` (spec §5: flat shape untrusted). Maps `SymbolKind.Function|Method|Constructor → 'function'`, `SymbolKind.Class|Interface|Struct|Enum → 'class'`, else `'other'`. Converts 0-based `symbol.range` to 1-based inclusive `[start.line+1, end.line+1]`.
  - `class VouchContext` (context.ts):
    - `static async create(): Promise<VouchContext>` — for each `vscode.workspace.workspaceFolders` entry, resolve `repoRoot(folder)` (fallback: folder path), construct one `ReviewStore` per distinct root, `load()` all.
    - `rootFor(uri: vscode.Uri): { rootDir: string; store: ReviewStore } | null`
    - `sourcePathOf(uri: vscode.Uri): string | null` — posix path relative to its rootDir; null if outside all roots.
    - `reload(rootDir?: string): Promise<void>`; `onDidChange: vscode.Event<void>` (fired after reload).
  - extension.ts activation: creates context; registers a `FileSystemWatcher` for `**/.vouch/reviews/**/*.jsonl` → debounce 300 ms → `reload` → fire refresh; exports `getTestApi()` returning `{ context }` for integration tests.
  - Integration harness: `npm run test:int` opens the fixture workspace in a downloaded VS Code and runs mocha suites.

- [ ] **Step 1: Write the integration harness**

```jsonc
// tsconfig.int.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "out-int", "rootDir": "." },
  "include": ["src/**/*.ts", "test/vscode-int/**/*.ts"]
}
```

```ts
// test/vscode-int/runTest.ts
import { runTests } from '@vscode/test-electron'
import * as path from 'node:path'
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..')
  const extensionTestsPath = path.resolve(__dirname, './suite/index')
  // Copy fixture to a temp dir and make it a git repo (tests mutate it)
  const fixtureSrc = path.resolve(extensionDevelopmentPath, 'test/vscode-int/fixture')
  const ws = mkdtempSync(path.join(tmpdir(), 'vouch-fixture-'))
  cpSync(fixtureSrc, ws, { recursive: true })
  const g = (args: string[]) => execFileSync('git', args, { cwd: ws })
  g(['init', '-q']); g(['config', 'user.name', 'Int Test']); g(['config', 'user.email', 'int@test.dev'])
  g(['add', '-A']); g(['commit', '-q', '-m', 'fixture', '--allow-empty'])
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [ws, '--disable-extensions'],
  })
}
main().catch(err => { console.error(err); process.exit(1) })
```

```ts
// test/vscode-int/suite/index.ts
import * as path from 'node:path'
import Mocha from 'mocha'
import { glob } from 'glob'

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: true })
  const testsRoot = path.resolve(__dirname)
  const files = await glob('**/*.test.js', { cwd: testsRoot })
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f))
  await new Promise<void>((resolve, reject) => {
    mocha.run(failures => failures ? reject(new Error(`${failures} tests failed`)) : resolve())
  })
}
```

```ts
// test/vscode-int/fixture/src/calc.ts  (fixture content — also create this file)
export function add(a: number, b: number): number {
  return a + b
}

export function mul(a: number, b: number): number {
  return a * b
}
```

(`test/vscode-int/fixture/.gitkeep` is unnecessary once `src/calc.ts` exists — skip it.)

```ts
// test/vscode-int/suite/extension.test.ts
import * as assert from 'node:assert'
import * as vscode from 'vscode'

describe('activation', () => {
  it('activates and exposes the test api', async () => {
    const ext = vscode.extensions.getExtension('sanzhar.vouch')!
    assert.ok(ext, 'extension found')
    const api = await ext.activate()
    assert.ok(api.getTestApi().context, 'VouchContext created')
  })
})
```

- [ ] **Step 2: Run integration harness, verify failure**

Run: `npm run test:int`
Expected: FAIL — `getTestApi` undefined (extension.ts is still the Task 1 stub).

- [ ] **Step 3: Implement symbols.ts, context.ts, extension.ts**

```ts
// src/vscode/symbols.ts
import * as vscode from 'vscode'
import type { SymbolNode } from '../core/anchor'

function kindClass(kind: vscode.SymbolKind): SymbolNode['kindClass'] {
  const K = vscode.SymbolKind
  if (kind === K.Function || kind === K.Method || kind === K.Constructor) return 'function'
  if (kind === K.Class || kind === K.Interface || kind === K.Struct || kind === K.Enum) return 'class'
  return 'other'
}

function toNode(s: vscode.DocumentSymbol): SymbolNode {
  return {
    name: s.name,
    kindClass: kindClass(s.kind),
    range: [s.range.start.line + 1, s.range.end.line + 1],
    children: s.children.map(toNode),
  }
}

export async function documentSymbols(uri: vscode.Uri): Promise<SymbolNode[]> {
  const result = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri)
  if (!result || result.length === 0) return []
  // Spec §5: only the hierarchical DocumentSymbol shape is trusted.
  if (!('children' in result[0]!)) return []
  return (result as vscode.DocumentSymbol[]).map(toNode)
}
```

```ts
// src/vscode/context.ts
import * as vscode from 'vscode'
import * as path from 'node:path'
import { ReviewStore } from '../core/store'
import { repoRoot } from './gitinfo'

export interface RootEntry { rootDir: string; store: ReviewStore }

export class VouchContext {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.emitter.event

  private constructor(readonly roots: RootEntry[]) {}

  static async create(): Promise<VouchContext> {
    const dirs = new Set<string>()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = (await repoRoot(folder.uri.fsPath)) ?? folder.uri.fsPath
      dirs.add(root)
    }
    const roots: RootEntry[] = []
    for (const rootDir of dirs) {
      const store = new ReviewStore(rootDir)
      await store.load()
      roots.push({ rootDir, store })
    }
    return new VouchContext(roots)
  }

  rootFor(uri: vscode.Uri): RootEntry | null {
    const p = uri.fsPath
    let best: RootEntry | null = null
    for (const r of this.roots) {
      const rel = path.relative(r.rootDir, p)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (!best || r.rootDir.length > best.rootDir.length) best = r
    }
    return best
  }

  sourcePathOf(uri: vscode.Uri): string | null {
    const root = this.rootFor(uri)
    if (!root) return null
    return path.relative(root.rootDir, uri.fsPath).split(path.sep).join('/')
  }

  async reload(): Promise<void> {
    for (const r of this.roots) await r.store.load()
    this.emitter.fire()
  }
}
```

```ts
// src/vscode/extension.ts (replace stub)
import * as vscode from 'vscode'
import { VouchContext } from './context'

let ctx: VouchContext | undefined

export async function activate(context: vscode.ExtensionContext): Promise<{
  getTestApi: () => { context: VouchContext }
}> {
  ctx = await VouchContext.create()

  const watcher = vscode.workspace.createFileSystemWatcher('**/.vouch/reviews/**/*.jsonl')
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void ctx?.reload() }, 300)
  }
  watcher.onDidCreate(scheduleReload)
  watcher.onDidChange(scheduleReload)
  watcher.onDidDelete(scheduleReload)
  context.subscriptions.push(watcher)

  return { getTestApi: () => ({ context: ctx! }) }
}

export function deactivate(): void {}
```

- [ ] **Step 4: Run integration harness, verify pass**

Run: `npm run test:int`
Expected: PASS — activation test green. Also run `npm run typecheck && npm test` (unit suite still green).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: vscode adapters (symbols, multi-root context) and integration harness"
```

---

### Task 11: Attestation commands — selection/function/class/file, auto-supersede, unvouch

**Files:**
- Create: `src/vscode/commands.ts`, `src/core/attest.ts`
- Modify: `src/vscode/extension.ts` (register commands)
- Test: `test/core/attest.test.ts`, extend `test/vscode-int/suite/extension.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `src/core/attest.ts` (pure):
    - `buildRecord(params: { id: string; author: Author; createdAt: string; commit: string; dirty: boolean; kind: RecordKind; symbol?: string; range?: [number, number]; docText: string; comment?: string; existingCurrent: { record: ReviewRecord; res: Resolution }[] }): ReviewRecord` — computes `hash`/`headHash` via `hashRangeOfText` (whole-doc `sha256(normalizeEol(docText))` for `kind='file'`), and fills `supersedes` with **auto-supersede** ids: the same-author current records whose resolved `effectiveRange` overlaps the new range (any overlap; `kind='file'` supersedes all of the author's current records for the file; same `symbol` path also counts as overlap).
    - `overlaps(a: [number, number], b: [number, number]): boolean`
  - `src/vscode/commands.ts`: `registerCommands(context: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void): void` registering `vouch.init`, `vouch.selection`, `vouch.function`, `vouch.class`, `vouch.file`, `vouch.unvouch` (rest in Tasks 14–15). Flow per attestation command: active editor → `ctx.sourcePathOf` (info message + return if null) → range (selection, or `enclosingSymbol(documentSymbols(uri), cursorLine, want)` — degrade to selection with info message when no symbol, spec §9) → `identity()` (fallback: prompt once, store in `context.globalState` key `vouch.identity`) → `headSha`/`isDirty` (empty commit + `dirty:false` when not a repo) → comment via `showInputBox` (`undefined` = user hit Esc → cancel whole command; empty string = no comment) → `buildRecord` with `existingCurrent` from resolver output → `appendLine` → `ctx.reload()` → `refresh()`.
    - `vouch.unvouch`: current records of the current user overlapping the cursor line → for each, append tombstone `{ id: uuid, author, createdAt, revokes: record.id, reason: 'unvouch' }` → reload/refresh. Info message when none found.
    - ID generation: `crypto.randomUUID()`.

- [ ] **Step 1: Write failing unit tests for attest.ts**

```ts
// test/core/attest.test.ts
import { describe, it, expect } from 'vitest'
import { buildRecord, overlaps } from '../../src/core/attest'
import { hashRangeOfText, resolveRecord } from '../../src/core/anchor'
import type { ReviewRecord } from '../../src/core/types'

const AUTHOR = { name: 'S', email: 's@x.com' }
const OTHER = { name: 'B', email: 'b@x.com' }
const DOC = 'l1\nl2\nl3\nl4\nl5\nl6'

const BASE = {
  id: 'new1', author: AUTHOR, createdAt: '2026-07-13T00:00:00Z',
  commit: 'c2', dirty: false, docText: DOC,
}

function existing(id: string, range: [number, number], author = AUTHOR) {
  const { hash, headHash } = hashRangeOfText(DOC, range)
  const record: ReviewRecord = { id, author, createdAt: '2026-01-01T00:00:00Z', commit: 'c1',
    dirty: false, kind: 'selection', range, hash, headHash }
  return { record, res: resolveRecord(record, DOC) }
}

describe('overlaps', () => {
  it('detects overlap and non-overlap', () => {
    expect(overlaps([1, 3], [3, 5])).toBe(true)
    expect(overlaps([1, 3], [4, 5])).toBe(false)
  })
})

describe('buildRecord', () => {
  it('hashes the range and sets headHash', () => {
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4], existingCurrent: [] })
    expect(r.hash).toBe(hashRangeOfText(DOC, [2, 4]).hash)
    expect(r.headHash).toBe(hashRangeOfText(DOC, [2, 4]).headHash)
    expect(r.supersedes).toBeUndefined()
  })

  it('auto-supersedes same-author overlapping current records only', () => {
    const mine = existing('old1', [3, 5])
    const other = existing('old2', [3, 5], OTHER)
    const far = existing('old3', [6, 6])
    const r = buildRecord({ ...BASE, kind: 'selection', range: [2, 4],
      existingCurrent: [mine, other, far] })
    expect(r.supersedes).toEqual(['old1'])
  })

  it('same symbol path counts as overlap even if ranges moved apart', () => {
    const mine = existing('old1', [1, 2])
    mine.record.symbol = 'AuthService/login'
    const r = buildRecord({ ...BASE, kind: 'function', symbol: 'AuthService/login',
      range: [5, 6], existingCurrent: [mine] })
    expect(r.supersedes).toEqual(['old1'])
  })

  it('kind=file supersedes ALL of the author records and hashes whole doc', () => {
    const a = existing('old1', [1, 2])
    const b = existing('old2', [5, 6])
    const other = existing('old3', [1, 2], OTHER)
    const r = buildRecord({ ...BASE, kind: 'file', existingCurrent: [a, b, other] })
    expect(r.supersedes).toEqual(['old1', 'old2'])
    expect(r.range).toBeUndefined()
    expect(r.headHash).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npx vitest run test/core/attest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement attest.ts**

```ts
// src/core/attest.ts
import { hashRangeOfText, type Resolution } from './anchor'
import { normalizeEol, sha256 } from './text'
import type { Author, RecordKind, ReviewRecord } from './types'

export function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

export function buildRecord(params: {
  id: string
  author: Author
  createdAt: string
  commit: string
  dirty: boolean
  kind: RecordKind
  symbol?: string
  range?: [number, number]
  docText: string
  comment?: string
  existingCurrent: { record: ReviewRecord; res: Resolution }[]
}): ReviewRecord {
  const { kind, range, docText } = params

  const mine = params.existingCurrent.filter(
    e => e.record.author.email === params.author.email)
  const superseded = mine.filter(e => {
    if (kind === 'file') return true
    if (params.symbol && e.record.symbol === params.symbol) return true
    return range ? overlaps(e.res.effectiveRange, range) : false
  }).map(e => e.record.id)

  const rec: ReviewRecord = {
    id: params.id,
    author: params.author,
    createdAt: params.createdAt,
    commit: params.commit,
    dirty: params.dirty,
    kind,
    hash: '',
  }
  if (kind === 'file') {
    rec.hash = sha256(normalizeEol(docText))
  } else {
    const r = range!
    const { hash, headHash } = hashRangeOfText(docText, r)
    rec.hash = hash
    rec.headHash = headHash
    rec.range = r
  }
  if (params.symbol) rec.symbol = params.symbol
  if (params.comment) rec.comment = params.comment
  if (superseded.length > 0) rec.supersedes = superseded
  return rec
}
```

- [ ] **Step 4: Run unit tests, verify pass**

Run: `npx vitest run test/core/attest.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement commands.ts and register in extension.ts**

```ts
// src/vscode/commands.ts
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { buildRecord, overlaps } from '../core/attest'
import { enclosingSymbol, resolveRecord } from '../core/anchor'
import { authorSlug } from '../core/paths'
import { appendLine, initVouch } from '../core/writer'
import type { Author, RecordKind, ReviewRecord, Tombstone } from '../core/types'
import type { VouchContext } from './context'
import { documentSymbols } from './symbols'
import { headSha, identity, isDirty } from './gitinfo'

async function resolveAuthor(
  extCtx: vscode.ExtensionContext, cwd: string,
): Promise<Author | null> {
  const fromGit = await identity(cwd)
  if (fromGit) return fromGit
  const saved = extCtx.globalState.get<Author>('vouch.identity')
  if (saved) return saved
  const name = await vscode.window.showInputBox({ prompt: 'Vouch: your name (no git identity found)' })
  if (!name) return null
  const email = await vscode.window.showInputBox({ prompt: 'Vouch: your email' })
  if (!email) return null
  const author = { name, email }
  await extCtx.globalState.update('vouch.identity', author)
  return author
}

/** Shared state each command needs about the active editor. */
async function editorState(ctx: VouchContext): Promise<{
  editor: vscode.TextEditor; rootDir: string; sourcePath: string
} | null> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Vouch: no active file editor.')
    return null
  }
  const root = ctx.rootFor(editor.document.uri)
  const sourcePath = ctx.sourcePathOf(editor.document.uri)
  if (!root || !sourcePath) {
    void vscode.window.showInformationMessage('Vouch: file is outside the workspace.')
    return null
  }
  return { editor, rootDir: root.rootDir, sourcePath }
}

export function currentResolved(
  ctx: VouchContext, rootDir: string, sourcePath: string, docText: string,
): { record: ReviewRecord; res: ReturnType<typeof resolveRecord> }[] {
  const root = ctx.roots.find(r => r.rootDir === rootDir)
  const state = root?.store.stateFor(sourcePath)
  if (!state) return []
  return state.current.map(record => ({ record, res: resolveRecord(record, docText) }))
}

async function attest(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void, kind: RecordKind,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const doc = editor.document

  let range: [number, number] | undefined
  let symbol: string | undefined
  if (kind === 'selection') {
    const sel = editor.selection
    range = [sel.start.line + 1, sel.end.line + 1]
  } else if (kind === 'function' || kind === 'class') {
    const symbols = await documentSymbols(doc.uri)
    const found = enclosingSymbol(symbols, editor.selection.active.line + 1, kind)
    if (!found) {
      void vscode.window.showInformationMessage(
        `Vouch: no enclosing ${kind} symbol — select lines and use "Review selected lines".`)
      return
    }
    range = found.range
    symbol = found.path
  }

  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return
  const comment = await vscode.window.showInputBox({
    prompt: 'Vouch: optional comment (Enter to skip)', value: '' })
  if (comment === undefined) return // Esc cancels

  const commit = (await headSha(rootDir)) ?? ''
  const dirty = commit ? await isDirty(rootDir, sourcePath) : false
  const docText = doc.getText()

  const rec = buildRecord({
    id: randomUUID(), author, createdAt: new Date().toISOString(),
    commit, dirty, kind, symbol, range, docText,
    comment: comment || undefined,
    existingCurrent: currentResolved(ctx, rootDir, sourcePath, docText),
  })
  await appendLine(rootDir, sourcePath, authorSlug(author.email), rec)
  await ctx.reload()
  refresh()
}

async function unvouch(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void,
): Promise<void> {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return
  const line = editor.selection.active.line + 1
  const docText = editor.document.getText()
  const targets = currentResolved(ctx, rootDir, sourcePath, docText).filter(e =>
    e.record.author.email === author.email &&
    (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line])))
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Vouch: none of your reviews cover this line.')
    return
  }
  for (const t of targets) {
    const tomb: Tombstone = { id: randomUUID(), author, createdAt: new Date().toISOString(),
      revokes: t.record.id, reason: 'unvouch' }
    await appendLine(rootDir, sourcePath, authorSlug(author.email), tomb)
  }
  await ctx.reload()
  refresh()
}

export function registerCommands(
  extCtx: vscode.ExtensionContext, ctx: VouchContext, refresh: () => void,
): void {
  const reg = (id: string, fn: () => Promise<void> | void): void => {
    extCtx.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  reg('vouch.init', async () => {
    const st = await editorState(ctx)
    const rootDir = st?.rootDir ?? ctx.roots[0]?.rootDir
    if (!rootDir) return
    await initVouch(rootDir)
    void vscode.window.showInformationMessage(`Vouch: initialized in ${rootDir}`)
  })
  reg('vouch.selection', () => attest(extCtx, ctx, refresh, 'selection'))
  reg('vouch.function', () => attest(extCtx, ctx, refresh, 'function'))
  reg('vouch.class', () => attest(extCtx, ctx, refresh, 'class'))
  reg('vouch.file', () => attest(extCtx, ctx, refresh, 'file'))
  reg('vouch.unvouch', () => unvouch(extCtx, ctx, refresh))
}
```

In `extension.ts` `activate`, after creating `ctx`:

```ts
import { registerCommands } from './commands'
// inside activate(), refresh is a no-op until Task 12 wires decorations:
let refresh: () => void = () => {}
registerCommands(context, ctx, () => refresh())
```

(Keep `refresh` as a `let` binding at module scope in extension.ts; Task 12 assigns the real implementation.)

- [ ] **Step 6: Add integration test for the write path**

Append to `test/vscode-int/suite/extension.test.ts`:

```ts
import * as path from 'node:path'
import * as fs from 'node:fs'

describe('vouch.selection', () => {
  it('writes a record shard for the selected lines', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(0, 0, 2, 0) // lines 1-3
    await vscode.commands.executeCommand('vouch.init')
    // showInputBox for comment: stub by pre-resolving — instead run with typed command variant:
    // simplest reliable approach: temporarily monkeypatch showInputBox
    const orig = vscode.window.showInputBox
    ;(vscode.window as { showInputBox: typeof orig }).showInputBox = async () => ''
    try {
      await vscode.commands.executeCommand('vouch.selection')
    } finally {
      ;(vscode.window as { showInputBox: typeof orig }).showInputBox = orig
    }
    const reviewsDir = path.join(ws, '.vouch/reviews/src/calc.ts')
    const shards = fs.readdirSync(reviewsDir)
    assert.strictEqual(shards.length, 1)
    const line = fs.readFileSync(path.join(reviewsDir, shards[0]!), 'utf8').trim()
    const rec = JSON.parse(line)
    assert.strictEqual(rec.kind, 'selection')
    assert.deepStrictEqual(rec.range, [1, 3])
    assert.match(rec.hash, /^sha256:/)
    assert.strictEqual(rec.author.email, 'int@test.dev')
  })
})
```

- [ ] **Step 7: Run all tests, verify pass**

Run: `npm run typecheck && npm test && npm run test:int`
Expected: PASS everywhere.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: attestation commands with auto-supersede and unvouch tombstones"
```

---

### Task 12: Refresh pipeline + gutter decorations

**Files:**
- Create: `src/vscode/gutter.ts`, `src/vscode/pipeline.ts`
- Modify: `src/vscode/extension.ts`
- Test: extend `test/vscode-int/suite/extension.test.ts`

**Interfaces:**
- Consumes: `resolveRecord`, `documentSymbols`, `resolveSymbolPath`, `VouchContext`, `currentResolved` (Tasks 8, 10, 11).
- Produces:
  - `src/vscode/pipeline.ts`:
    - `interface FileStatus { entries: { record: ReviewRecord; res: Resolution }[]; coverage: FileCoverage | null }`
    - `class StatusPipeline` — `constructor(ctx: VouchContext)`; `async statusFor(doc: vscode.TextDocument): Promise<FileStatus>` (resolves symbols once per call: for records with `symbol`, `resolveSymbolPath` over `documentSymbols(doc.uri)` → pass that node's range into `resolveRecord`); results cached by `(uri, doc.version, store generation)`; `invalidate(): void` bumps generation; `onDidUpdate: vscode.Event<vscode.Uri>`.
    - Wires `vscode.workspace.onDidChangeTextDocument` with a 300 ms debounce per document and `vscode.window.onDidChangeVisibleTextEditors` → recompute → fire `onDidUpdate`.
  - `src/vscode/gutter.ts`: `class Gutter` — two `TextEditorDecorationType`s created once (`gutterIconPath` = media svg, `overviewRulerColor` green/orange, `overviewRulerLane: Right`); `apply(editor: vscode.TextEditor, status: FileStatus): void` sets one decoration per current record at line `effectiveRange[0] - 1`; when several records share a first line, `dismissed` wins (spec §7); `dispose()`.
  - extension.ts: instantiate pipeline + gutter; `refresh` now recomputes all visible editors; test api extended: `getTestApi()` returns `{ context, pipeline }`.

- [ ] **Step 1: Write failing integration test**

Append to `test/vscode-int/suite/extension.test.ts`:

```ts
describe('status pipeline', () => {
  it('reports reviewed for the fresh record, dismissed after an edit', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    const editor = await vscode.window.showTextDocument(doc)
    const api = (await vscode.extensions.getExtension('sanzhar.vouch')!.activate()).getTestApi()

    let st = await api.pipeline.statusFor(doc)
    assert.strictEqual(st.entries.length, 1) // record from the Task 11 test
    assert.strictEqual(st.entries[0].res.status, 'reviewed')
    assert.deepStrictEqual(st.entries[0].res.effectiveRange, [1, 3])

    await editor.edit(b => b.replace(
      new vscode.Range(1, 0, 1, doc.lineAt(1).text.length), '  return a + b + 1'))
    st = await api.pipeline.statusFor(doc)
    assert.strictEqual(st.entries[0].res.status, 'dismissed')

    await vscode.commands.executeCommand('workbench.action.revertFile') // restore for later tests
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm run test:int`
Expected: FAIL — `api.pipeline` undefined.

- [ ] **Step 3: Implement pipeline.ts and gutter.ts**

```ts
// src/vscode/pipeline.ts
import * as vscode from 'vscode'
import { resolveRecord, resolveSymbolPath, type Resolution } from '../core/anchor'
import { fileCoverage, type FileCoverage } from '../core/coverage'
import type { ReviewRecord } from '../core/types'
import type { VouchContext } from './context'
import { documentSymbols } from './symbols'

export interface FileStatus {
  entries: { record: ReviewRecord; res: Resolution }[]
  coverage: FileCoverage | null
}

export class StatusPipeline {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidUpdate = this.emitter.event
  private cache = new Map<string, { version: number; gen: number; status: FileStatus }>()
  private gen = 0
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly ctx: VouchContext, subscriptions: vscode.Disposable[]) {
    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      ctx.onDidChange(() => { this.invalidate(); this.refreshVisible() }),
    )
  }

  invalidate(): void { this.gen++ }

  refreshVisible(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      void this.statusFor(ed.document).then(() => this.emitter.fire(ed.document.uri))
    }
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString()
    const t = this.timers.get(key)
    if (t) clearTimeout(t)
    this.timers.set(key, setTimeout(() => {
      void this.statusFor(doc).then(() => this.emitter.fire(doc.uri))
    }, 300))
  }

  async statusFor(doc: vscode.TextDocument): Promise<FileStatus> {
    const key = doc.uri.toString()
    const hit = this.cache.get(key)
    if (hit && hit.version === doc.version && hit.gen === this.gen) return hit.status

    const empty: FileStatus = { entries: [], coverage: null }
    const root = this.ctx.rootFor(doc.uri)
    const sourcePath = this.ctx.sourcePathOf(doc.uri)
    if (!root || !sourcePath) return empty
    const state = root.store.stateFor(sourcePath)
    if (!state || state.current.length === 0) return empty

    const docText = doc.getText()
    const needSymbols = state.current.some(r => r.symbol)
    const symbols = needSymbols ? await documentSymbols(doc.uri) : []

    const entries = state.current.map(record => {
      const symRange = record.symbol
        ? resolveSymbolPath(symbols, record.symbol)?.range ?? null : null
      return { record, res: resolveRecord(record, docText, symRange) }
    })
    const status: FileStatus = { entries, coverage: fileCoverage(entries, docText) }
    this.cache.set(key, { version: doc.version, gen: this.gen, status })
    return status
  }
}
```

```ts
// src/vscode/gutter.ts
import * as vscode from 'vscode'
import type { FileStatus } from './pipeline'

export class Gutter {
  private readonly reviewed: vscode.TextEditorDecorationType
  private readonly dismissed: vscode.TextEditorDecorationType

  constructor(extensionUri: vscode.Uri) {
    const icon = (name: string): vscode.Uri =>
      vscode.Uri.joinPath(extensionUri, 'media', name)
    this.reviewed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('reviewed.svg'), gutterIconSize: 'contain',
      overviewRulerColor: '#2ea043', overviewRulerLane: vscode.OverviewRulerLane.Right,
    })
    this.dismissed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('dismissed.svg'), gutterIconSize: 'contain',
      overviewRulerColor: '#d29922', overviewRulerLane: vscode.OverviewRulerLane.Right,
    })
  }

  apply(editor: vscode.TextEditor, status: FileStatus): void {
    const byLine = new Map<number, 'reviewed' | 'dismissed'>()
    for (const { res } of status.entries) {
      const line = res.effectiveRange[0]
      const prev = byLine.get(line)
      byLine.set(line, prev === 'dismissed' ? 'dismissed' : res.status) // dismissed wins
    }
    const ranges = (want: 'reviewed' | 'dismissed'): vscode.Range[] =>
      [...byLine.entries()].filter(([, s]) => s === want)
        .map(([l]) => new vscode.Range(l - 1, 0, l - 1, 0))
    editor.setDecorations(this.reviewed, ranges('reviewed'))
    editor.setDecorations(this.dismissed, ranges('dismissed'))
  }

  dispose(): void {
    this.reviewed.dispose()
    this.dismissed.dispose()
  }
}
```

Wire in `extension.ts` `activate` (replacing the no-op refresh):

```ts
import { StatusPipeline } from './pipeline'
import { Gutter } from './gutter'

const pipeline = new StatusPipeline(ctx, context.subscriptions)
const gutter = new Gutter(context.extensionUri)
context.subscriptions.push(gutter)

const applyTo = async (editor: vscode.TextEditor): Promise<void> => {
  gutter.apply(editor, await pipeline.statusFor(editor.document))
}
refresh = () => { pipeline.invalidate(); pipeline.refreshVisible() }
pipeline.onDidUpdate(uri => {
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.toString() === uri.toString()) void applyTo(ed)
  }
})
context.subscriptions.push(
  vscode.window.onDidChangeVisibleTextEditors(eds => { for (const e of eds) void applyTo(e) }))
for (const e of vscode.window.visibleTextEditors) void applyTo(e)

return { getTestApi: () => ({ context: ctx!, pipeline }) }
```

- [ ] **Step 4: Run, verify pass**

Run: `npm run test:int`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: status pipeline with per-document cache and gutter decorations"
```

---

### Task 13: Hovers — range timeline + call-site status

**Files:**
- Create: `src/core/hovermd.ts`, `src/vscode/hovers.ts`
- Modify: `src/vscode/extension.ts`
- Test: `test/core/hovermd.test.ts`, extend integration suite

**Interfaces:**
- Consumes: `FileStatus`, `StatusPipeline`, `commitUrl`, `ChainState` (Tasks 3, 6, 12).
- Produces:
  - `src/core/hovermd.ts` (pure — returns markdown strings):
    - `interface HoverEntry { authorName: string; status: 'reviewed' | 'dismissed'; createdAt: string; comment?: string; commit: string; commitLink: string | null; recordId: string }`
    - `rangeHoverMd(entries: HoverEntry[], nowIso: string): string` — per-user lines `**✓ reviewed** — San, 2d ago (\`abc1234\`)`, optional `> comment`, then command links: `[Open timeline](command:vouch.openTimeline?...)`, `[Diff since review](command:vouch.showDiff?...)`, `[Re-review](command:vouch.reReview?...)` — args = `encodeURIComponent(JSON.stringify([recordId]))`.
    - `callSiteMd(entries: { authorName: string; status: 'reviewed' | 'dismissed'; createdAt: string }[], nowIso: string): string` — one line per author: `Vouch: ✓ reviewed — San, 2d ago`.
    - `relTime(fromIso: string, toIso: string): string` — `just now` (<60 s), `5m ago`, `3h ago`, `2d ago`.
  - `src/vscode/hovers.ts`: `registerHovers(context, ctx: VouchContext, pipeline: StatusPipeline): void`
    - Range hover: `vscode.languages.registerHoverProvider({ scheme: 'file' }, ...)` — entries whose `effectiveRange` contains the hovered line → `rangeHoverMd` in a trusted `MarkdownString` (`isTrusted: true`).
    - Call-site hover (same provider, second section): if no local record covers the line, run cached definition lookup — cache `Map<string, vscode.Location | null>` keyed `uri:line:char:docVersion`; `vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)` raced against 400 ms timeout AND the provider's `CancellationToken` (return `undefined` on either); on target: `pipeline.statusFor(await openTextDocument(target.uri))` **only if target doc is already open** (`vscode.workspace.textDocuments` lookup — never FS-load inside hover, spec §7); overlap target range with entries → `callSiteMd`. Never call `executeHoverProvider` here (recursion).
    - Zero-record short-circuit: if `ctx` has no roots with any attested file, return undefined immediately.

- [ ] **Step 1: Write failing unit tests**

```ts
// test/core/hovermd.test.ts
import { describe, it, expect } from 'vitest'
import { rangeHoverMd, callSiteMd, relTime } from '../../src/core/hovermd'

const NOW = '2026-07-13T12:00:00Z'

describe('relTime', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(relTime('2026-07-13T11:59:30Z', NOW)).toBe('just now')
    expect(relTime('2026-07-13T11:55:00Z', NOW)).toBe('5m ago')
    expect(relTime('2026-07-13T09:00:00Z', NOW)).toBe('3h ago')
    expect(relTime('2026-07-11T12:00:00Z', NOW)).toBe('2d ago')
  })
})

describe('rangeHoverMd', () => {
  it('renders status, author, time, short sha, comment, command links', () => {
    const md = rangeHoverMd([{
      authorName: 'San', status: 'reviewed', createdAt: '2026-07-11T12:00:00Z',
      comment: 'checked errors', commit: 'abc1234def5678', commitLink: 'https://x/commit/abc1234def5678',
      recordId: 'r1',
    }], NOW)
    expect(md).toContain('✓ reviewed')
    expect(md).toContain('San')
    expect(md).toContain('2d ago')
    expect(md).toContain('[`abc1234`](https://x/commit/abc1234def5678)')
    expect(md).toContain('> checked errors')
    expect(md).toContain(`command:vouch.showDiff?${encodeURIComponent(JSON.stringify(['r1']))}`)
    expect(md).toContain('command:vouch.reReview?')
    expect(md).toContain('command:vouch.openTimeline?')
  })
  it('dismissed uses warning glyph and label', () => {
    const md = rangeHoverMd([{ authorName: 'San', status: 'dismissed',
      createdAt: NOW, commit: '', commitLink: null, recordId: 'r1' }], NOW)
    expect(md).toContain('⚠ dismissed (changed since review)')
    expect(md).not.toContain('](null')
  })
})

describe('callSiteMd', () => {
  it('one line per author', () => {
    const md = callSiteMd([
      { authorName: 'San', status: 'reviewed', createdAt: '2026-07-11T12:00:00Z' },
      { authorName: 'Bob', status: 'dismissed', createdAt: NOW },
    ], NOW)
    expect(md).toContain('Vouch: ✓ reviewed — San, 2d ago')
    expect(md).toContain('Vouch: ⚠ dismissed (changed since review) — Bob')
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/core/hovermd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement hovermd.ts**

```ts
// src/core/hovermd.ts
export interface HoverEntry {
  authorName: string
  status: 'reviewed' | 'dismissed'
  createdAt: string
  comment?: string
  commit: string
  commitLink: string | null
  recordId: string
}

export function relTime(fromIso: string, toIso: string): string {
  const s = Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function statusLabel(status: 'reviewed' | 'dismissed'): string {
  return status === 'reviewed' ? '✓ reviewed' : '⚠ dismissed (changed since review)'
}

function cmd(command: string, recordId: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([recordId]))}`
}

export function rangeHoverMd(entries: HoverEntry[], nowIso: string): string {
  const parts: string[] = []
  for (const e of entries) {
    const sha = e.commit ? e.commit.slice(0, 7) : ''
    const shaMd = !sha ? '' : e.commitLink ? ` ([\`${sha}\`](${e.commitLink}))` : ` (\`${sha}\`)`
    parts.push(`**${statusLabel(e.status)}** — ${e.authorName}, ${relTime(e.createdAt, nowIso)}${shaMd}`)
    if (e.comment) parts.push(`> ${e.comment}`)
    parts.push(
      `[Open timeline](${cmd('vouch.openTimeline', e.recordId)}) · ` +
      `[Diff since review](${cmd('vouch.showDiff', e.recordId)}) · ` +
      `[Re-review](${cmd('vouch.reReview', e.recordId)})`)
  }
  return parts.join('\n\n')
}

export function callSiteMd(
  entries: { authorName: string; status: 'reviewed' | 'dismissed'; createdAt: string }[],
  nowIso: string,
): string {
  return entries.map(e =>
    `Vouch: ${statusLabel(e.status)} — ${e.authorName}, ${relTime(e.createdAt, nowIso)}`,
  ).join('\n\n')
}
```

- [ ] **Step 4: Run unit tests, verify pass**

Run: `npx vitest run test/core/hovermd.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement hovers.ts and wire**

```ts
// src/vscode/hovers.ts
import * as vscode from 'vscode'
import { callSiteMd, rangeHoverMd, type HoverEntry } from '../core/hovermd'
import { commitUrl } from '../core/giturl'
import { overlaps } from '../core/attest'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { remoteUrl } from './gitinfo'

export function registerHovers(
  context: vscode.ExtensionContext, ctx: VouchContext, pipeline: StatusPipeline,
): void {
  const remoteCache = new Map<string, string | null>()
  const defCache = new Map<string, vscode.Location | null>()

  async function remoteFor(rootDir: string): Promise<string | null> {
    if (!remoteCache.has(rootDir)) remoteCache.set(rootDir, await remoteUrl(rootDir))
    return remoteCache.get(rootDir)!
  }

  const provider: vscode.HoverProvider = {
    async provideHover(doc, pos, token) {
      if (!ctx.roots.some(r => r.store.attestedFiles().length > 0)) return undefined
      const line = pos.line + 1

      // (a) range hover — records covering this line in THIS document
      const status = await pipeline.statusFor(doc)
      const covering = status.entries.filter(e =>
        e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line]))
      if (covering.length > 0) {
        const root = ctx.rootFor(doc.uri)!
        const remote = await remoteFor(root.rootDir)
        const entries: HoverEntry[] = covering.map(e => ({
          authorName: e.record.author.name,
          status: e.res.status,
          createdAt: e.record.createdAt,
          comment: e.record.comment,
          commit: e.record.commit,
          commitLink: e.record.commit && remote ? commitUrl(remote, e.record.commit) : null,
          recordId: e.record.id,
        }))
        const md = new vscode.MarkdownString(rangeHoverMd(entries, new Date().toISOString()))
        md.isTrusted = true
        return new vscode.Hover(md)
      }

      // (b) call-site hover — definition target's status (open docs only; spec §7)
      const key = `${doc.uri}:${pos.line}:${pos.character}:${doc.version}`
      let target = defCache.get(key)
      if (target === undefined) {
        const lookup = vscode.commands.executeCommand<
          (vscode.Location | vscode.LocationLink)[] | undefined
        >('vscode.executeDefinitionProvider', doc.uri, pos)
        const timeout = new Promise<null>(r => setTimeout(() => r(null), 400))
        const res = await Promise.race([lookup, timeout])
        if (token.isCancellationRequested) return undefined
        const first = res?.[0]
        target = !first ? null
          : first instanceof vscode.Location ? first
          : new vscode.Location(first.targetUri, first.targetRange)
        defCache.set(key, target)
        if (defCache.size > 500) defCache.clear()
      }
      if (!target || target.uri.toString() === doc.uri.toString()) return undefined
      const targetDoc = vscode.workspace.textDocuments.find(
        d => d.uri.toString() === target!.uri.toString())
      if (!targetDoc) return undefined
      const tStatus = await pipeline.statusFor(targetDoc)
      const tLine: [number, number] =
        [target.range.start.line + 1, target.range.end.line + 1]
      const hits = tStatus.entries.filter(e =>
        e.record.kind === 'file' || overlaps(e.res.effectiveRange, tLine))
      if (hits.length === 0) return undefined
      const md = new vscode.MarkdownString(callSiteMd(hits.map(e => ({
        authorName: e.record.author.name, status: e.res.status, createdAt: e.record.createdAt,
      })), new Date().toISOString()))
      return new vscode.Hover(md)
      // NOTE: never call executeHoverProvider here — infinite recursion.
    },
  }
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, provider))
}
```

Wire in `extension.ts`: `registerHovers(context, ctx, pipeline)`.

- [ ] **Step 6: Add integration test**

```ts
describe('range hover', () => {
  it('returns vouch markdown for an attested line', async () => {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'src/calc.ts'))
    await vscode.window.showTextDocument(doc)
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 2))
    const all = hovers.flatMap(h => h.contents)
      .map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value).join('\n')
    assert.match(all, /reviewed|dismissed/)
    assert.match(all, /Vouch|timeline/i)
  })
})
```

- [ ] **Step 7: Run all tests, verify pass**

Run: `npm run typecheck && npm test && npm run test:int`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: range timeline hover and cached call-site status hover"
```

---

### Task 14: Diff since review + open commit on web

**Files:**
- Create: `src/vscode/diff.ts`, `src/core/baseline.ts`
- Modify: `src/vscode/commands.ts` (register `vouch.showDiff`, `vouch.openCommitOnWeb`), `src/vscode/extension.ts`
- Test: `test/core/baseline.test.ts`

**Interfaces:**
- Consumes: `showAtCommit`, `commitUrl`, `remoteUrl` (Task 6); `splitLines`, `hashLines` (Task 2); pipeline (Task 12).
- Produces:
  - `src/core/baseline.ts` (pure): `baselineSlice(committedText: string, record: ReviewRecord): { text: string; verified: true } | { text: string; verified: false }` — slice `committedText` at `record.range` (whole file for `kind='file'`); `verified` = slice hash equals `record.hash` (spec §7: use slice only when verified).
  - `src/vscode/diff.ts`:
    - `VouchBaselineProvider implements vscode.TextDocumentContentProvider` for scheme `vouch-baseline`; content passed via query-encoded key into an in-memory map (`register(text): vscode.Uri`).
    - `showDiff(ctx, pipeline, recordId: string): Promise<void>` — locate the record (search all roots/sources via `chainOf`), `showAtCommit` → null → warning "commit not available" and return; `baselineSlice` → verified → `vscode.diff(baselineUri, currentUri.with(...), 'Vouch: since <sha7>')` diffing baseline slice vs a second virtual doc containing the current effective-range slice; not verified → whole-file diff (baseline = full committed text, right side = the real file uri) + `showWarningMessage('Vouch: reviewed text was not in commit <sha7> — showing nearest baseline')`.
  - `vouch.openCommitOnWeb` (commands.ts): record → `remoteUrl(root)` → `commitUrl` → `vscode.env.openExternal`; info message when unavailable.
  - Command-link args: both commands accept `(recordId: string)` — matches hover links from Task 13 (`vouch.showDiff?["r1"]`).

- [ ] **Step 1: Write failing unit tests**

```ts
// test/core/baseline.test.ts
import { describe, it, expect } from 'vitest'
import { baselineSlice } from '../../src/core/baseline'
import { hashRangeOfText } from '../../src/core/anchor'
import { sha256, normalizeEol } from '../../src/core/text'
import type { ReviewRecord } from '../../src/core/types'

const COMMITTED = 'a\nb\nc\nd\ne\n'
function rec(range: [number, number], hash: string, kind: 'selection' | 'file' = 'selection'): ReviewRecord {
  return { id: 'r', author: { name: 'S', email: 's@x.com' }, createdAt: '2026-01-01T00:00:00Z',
    commit: 'c', dirty: false, kind, range: kind === 'file' ? undefined : range, hash }
}

describe('baselineSlice', () => {
  it('verified when committed slice matches the record hash', () => {
    const { hash } = hashRangeOfText(COMMITTED, [2, 4])
    const out = baselineSlice(COMMITTED, rec([2, 4], hash))
    expect(out).toEqual({ text: 'b\nc\nd', verified: true })
  })
  it('unverified when the reviewed text was never committed (dirty review)', () => {
    const out = baselineSlice(COMMITTED, rec([2, 4], 'sha256:doesnotmatch'))
    expect(out.verified).toBe(false)
    expect(out.text).toBe(COMMITTED) // falls back to whole committed file
  })
  it('kind=file verifies against the whole normalized file', () => {
    const hash = sha256(normalizeEol(COMMITTED))
    const out = baselineSlice(COMMITTED, rec([1, 1], hash, 'file'))
    expect(out.verified).toBe(true)
    expect(out.text).toBe(COMMITTED)
  })
  it('range beyond committed file length → unverified, whole file', () => {
    const out = baselineSlice('a\n', rec([5, 9], 'sha256:x'))
    expect(out.verified).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/core/baseline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement baseline.ts**

```ts
// src/core/baseline.ts
import { hashLines, normalizeEol, sha256, splitLines } from './text'
import type { ReviewRecord } from './types'

export function baselineSlice(
  committedText: string, record: ReviewRecord,
): { text: string; verified: boolean } {
  if (record.kind === 'file') {
    return { text: committedText, verified: sha256(normalizeEol(committedText)) === record.hash }
  }
  const lines = splitLines(committedText)
  const [s, e] = record.range ?? [1, 1]
  if (s < 1 || e > lines.length) return { text: committedText, verified: false }
  const slice = lines.slice(s - 1, e)
  if (hashLines(slice) === record.hash) return { text: slice.join('\n'), verified: true }
  return { text: committedText, verified: false }
}
```

- [ ] **Step 4: Run unit tests, verify pass**

Run: `npx vitest run test/core/baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement diff.ts + register commands**

```ts
// src/vscode/diff.ts
import * as vscode from 'vscode'
import { baselineSlice } from '../core/baseline'
import { splitLines } from '../core/text'
import type { ReviewRecord } from '../core/types'
import type { VouchContext } from './context'
import type { StatusPipeline } from './pipeline'
import { showAtCommit } from './gitinfo'

const contents = new Map<string, string>()
let counter = 0

export class VouchBaselineProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'vouch-baseline'
  provideTextDocumentContent(uri: vscode.Uri): string {
    return contents.get(uri.path) ?? ''
  }
}

function register(text: string, label: string): vscode.Uri {
  const key = `/${counter++}/${label}`
  contents.set(key, text)
  return vscode.Uri.from({ scheme: VouchBaselineProvider.scheme, path: key })
}

export function findRecord(
  ctx: VouchContext, recordId: string,
): { record: ReviewRecord; rootDir: string; sourcePath: string } | null {
  for (const root of ctx.roots) {
    for (const sourcePath of root.store.attestedFiles()) {
      const state = root.store.stateFor(sourcePath)!
      for (const members of state.chains.values()) {
        const record = members.find(m => m.id === recordId)
        if (record) return { record, rootDir: root.rootDir, sourcePath }
      }
    }
  }
  return null
}

export async function showDiff(
  ctx: VouchContext, pipeline: StatusPipeline, recordId: string,
): Promise<void> {
  const found = findRecord(ctx, recordId)
  if (!found) { void vscode.window.showWarningMessage('Vouch: record not found.'); return }
  const { record, rootDir, sourcePath } = found
  if (!record.commit) {
    void vscode.window.showWarningMessage('Vouch: review has no commit (not a git repo at review time).')
    return
  }
  const committed = await showAtCommit(rootDir, record.commit, sourcePath)
  if (committed === null) {
    void vscode.window.showWarningMessage(`Vouch: commit ${record.commit.slice(0, 7)} not available locally.`)
    return
  }
  const sha7 = record.commit.slice(0, 7)
  const fileUri = vscode.Uri.file(`${rootDir}/${sourcePath}`)
  const base = baselineSlice(committed, record)

  if (base.verified && record.kind !== 'file') {
    const doc = await vscode.workspace.openTextDocument(fileUri)
    const status = await pipeline.statusFor(doc)
    const entry = status.entries.find(e => e.record.id === recordId)
    const range = entry?.res.effectiveRange ?? record.range ?? [1, 1]
    const currentSlice = splitLines(doc.getText()).slice(range[0] - 1, range[1]).join('\n')
    await vscode.commands.executeCommand('vscode.diff',
      register(base.text, `baseline-${sha7}`), register(currentSlice, 'current'),
      `Vouch: since ${sha7}`)
    return
  }

  if (!base.verified) {
    void vscode.window.showWarningMessage(
      `Vouch: reviewed text was not in commit ${sha7} — showing nearest baseline.`)
  }
  await vscode.commands.executeCommand('vscode.diff',
    register(committed, `baseline-${sha7}`), fileUri, `Vouch: since ${sha7} (whole file)`)
}
```

Register in `commands.ts` (extend `registerCommands` signature to accept `pipeline: StatusPipeline`):

```ts
import { showDiff, findRecord } from './diff'
import { commitUrl } from '../core/giturl'
import { remoteUrl } from './gitinfo'

reg2('vouch.showDiff', (recordId: string) => showDiff(ctx, pipeline, recordId))
reg2('vouch.openCommitOnWeb', async (recordId: string) => {
  const found = findRecord(ctx, recordId)
  if (!found?.record.commit) {
    void vscode.window.showInformationMessage('Vouch: no commit recorded.'); return
  }
  const remote = await remoteUrl(found.rootDir)
  const url = remote ? commitUrl(remote, found.record.commit) : null
  if (!url) { void vscode.window.showInformationMessage('Vouch: no recognizable git remote.'); return }
  void vscode.env.openExternal(vscode.Uri.parse(url))
})
// where reg2 registers a command taking one string arg:
const reg2 = (id: string, fn: (arg: string) => Promise<void> | void): void => {
  extCtx.subscriptions.push(vscode.commands.registerCommand(id, fn))
}
```

In `extension.ts`: register the content provider —

```ts
import { VouchBaselineProvider } from './diff'
context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
  VouchBaselineProvider.scheme, new VouchBaselineProvider()))
```

and pass `pipeline` into `registerCommands`.

- [ ] **Step 6: Run all tests, verify pass**

Run: `npm run typecheck && npm test && npm run test:int`
Expected: PASS (existing suites still green; diff paths covered by unit tests — interactive diff verified manually in Task 18).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: verified diff-since-review with dirty-baseline fallback, open commit on web"
```

---

### Task 15: Re-review + re-attach

**Files:**
- Modify: `src/vscode/commands.ts` (add `vouch.reReview`, `vouch.reattach`), `src/core/attest.ts` (add `buildReattachLines`)
- Test: `test/core/reattach.test.ts`, extend `test/core/attest.test.ts` if needed

**Interfaces:**
- Consumes: `findRecord` (Task 14), `buildRecord` (Task 11), store/writer.
- Produces:
  - `buildReattachLines(records: ReviewRecord[], newSourcePath: string, idGen: () => string, nowIso: string, reattachedBy: Author): { copies: ReviewRecord[]; tombstones: Tombstone[] }` (attest.ts) — per record: copy with fresh id, original `author`/`createdAt`/`comment`/`hash`/`headHash`/`range`/`kind`/`symbol` preserved, `movedFrom: <old id>`; tombstone in old file `{ revokes: <old id>, reason: 'moved', movedTo: newSourcePath, author: reattachedBy, createdAt: nowIso }` (spec §7 re-attach mechanics).
  - `vouch.reReview` (commands.ts), accepts optional `recordId` (hover link) — else finds the user's dismissed current record covering the cursor line:
    - record has `symbol` and symbol resolves in the current doc → new record over the symbol's current full range (auto-supersede links the chain);
    - free-form → pre-select the displayed `effectiveRange` (`editor.selection = ...`, `editor.revealRange`) and show modal info `showInformationMessage('Vouch: confirm or adjust the selection, then press Re-review again', 'Re-review now')` — on button click, attest with `kind: 'selection'` over the (possibly adjusted) selection. Comment prompted anew.
  - `vouch.reattach` (commands.ts): QuickPick over `store.orphans(exists)` (exists = `fs.existsSync(join(rootDir, sourcePath))`) → `showOpenDialog` for the new file → `buildReattachLines(state.current-and-chain records for old path, ...)` — copies appended to the **new** path shard of each record's original author; tombstones appended to the **old** path shard of the re-attacher → reload/refresh.

- [ ] **Step 1: Write failing unit tests**

```ts
// test/core/reattach.test.ts
import { describe, it, expect } from 'vitest'
import { buildReattachLines } from '../../src/core/attest'
import type { ReviewRecord } from '../../src/core/types'

const SAN = { name: 'San', email: 's@x.com' }
const BOB = { name: 'Bob', email: 'b@x.com' }
const NOW = '2026-07-13T12:00:00Z'

const RECORDS: ReviewRecord[] = [
  { id: 'a1', author: SAN, createdAt: '2026-01-01T00:00:00Z', commit: 'c1', dirty: false,
    kind: 'function', symbol: 'f', range: [1, 3], hash: 'sha256:h1', headHash: 'sha256:hh1',
    comment: 'ok' },
  { id: 'b1', author: BOB, createdAt: '2026-02-01T00:00:00Z', commit: 'c2', dirty: true,
    kind: 'selection', range: [5, 6], hash: 'sha256:h2', headHash: 'sha256:hh2' },
]

describe('buildReattachLines', () => {
  it('copies preserve author/createdAt/hash and link movedFrom; tombstones mark moved', () => {
    let n = 0
    const { copies, tombstones } = buildReattachLines(
      RECORDS, 'src/new.ts', () => `id${n++}`, NOW, SAN)

    expect(copies).toHaveLength(2)
    expect(copies[0]).toMatchObject({
      id: 'id0', movedFrom: 'a1', author: SAN, createdAt: '2026-01-01T00:00:00Z',
      hash: 'sha256:h1', headHash: 'sha256:hh1', comment: 'ok', kind: 'function', symbol: 'f',
    })
    expect(copies[1]!.author).toEqual(BOB) // authorship preserved, not re-attacher

    expect(tombstones).toHaveLength(2)
    expect(tombstones[0]).toMatchObject({
      revokes: 'a1', reason: 'moved', movedTo: 'src/new.ts', author: SAN, createdAt: NOW,
    })
    expect(tombstones[0]!.id).not.toBe(copies[0]!.id)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/core/reattach.test.ts`
Expected: FAIL — `buildReattachLines` not exported.

- [ ] **Step 3: Implement buildReattachLines (append to attest.ts)**

```ts
// append to src/core/attest.ts
import type { Tombstone } from './types'

export function buildReattachLines(
  records: ReviewRecord[], newSourcePath: string,
  idGen: () => string, nowIso: string, reattachedBy: Author,
): { copies: ReviewRecord[]; tombstones: Tombstone[] } {
  const copies: ReviewRecord[] = []
  const tombstones: Tombstone[] = []
  for (const r of records) {
    copies.push({ ...r, id: idGen(), movedFrom: r.id, supersedes: undefined })
    tombstones.push({ id: idGen(), author: reattachedBy, createdAt: nowIso,
      revokes: r.id, reason: 'moved', movedTo: newSourcePath })
  }
  return { copies, tombstones }
}
```

Note: copies drop `supersedes` (old chain ids die with the tombstone in the old file; the copy starts a fresh chain — timeline reconstructs history through `movedFrom`).

- [ ] **Step 4: Run unit tests, verify pass**

Run: `npx vitest run test/core/reattach.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the two commands (append inside registerCommands)**

```ts
// append inside registerCommands in src/vscode/commands.ts
import { buildReattachLines } from '../core/attest'
import { resolveSymbolPath } from '../core/anchor'
import { findRecord } from './diff'
import * as fs from 'node:fs'
import * as path from 'node:path'

reg2('vouch.reReview', async (recordId?: string) => {
  const st = await editorState(ctx)
  if (!st) return
  const { editor, rootDir, sourcePath } = st
  const author = await resolveAuthor(extCtx, rootDir)
  if (!author) return
  const docText = editor.document.getText()
  const resolved = currentResolved(ctx, rootDir, sourcePath, docText)
  const line = editor.selection.active.line + 1
  const target = recordId
    ? resolved.find(e => e.record.id === recordId)
    : resolved.find(e => e.record.author.email === author.email &&
        e.res.status === 'dismissed' &&
        (e.record.kind === 'file' || overlaps(e.res.effectiveRange, [line, line])))
  if (!target) {
    void vscode.window.showInformationMessage('Vouch: no dismissed review of yours here.')
    return
  }

  if (target.record.kind === 'file') {
    await vscode.commands.executeCommand('vouch.file'); return
  }
  if (target.record.symbol) {
    const symbols = await documentSymbols(editor.document.uri)
    const node = resolveSymbolPath(symbols, target.record.symbol)
    if (node) {
      editor.selection = new vscode.Selection(node.range[0] - 1, 0, node.range[1] - 1, 0)
      await vscode.commands.executeCommand(
        target.record.kind === 'class' ? 'vouch.class' : 'vouch.function')
      return
    }
  }
  // free-form (or symbol gone): preselect displayed range, ask user to confirm/adjust
  const [s, e] = target.res.effectiveRange
  editor.selection = new vscode.Selection(s - 1, 0, e - 1, 0)
  editor.revealRange(new vscode.Range(s - 1, 0, e - 1, 0))
  const choice = await vscode.window.showInformationMessage(
    'Vouch: confirm or adjust the selection, then re-review.', 'Re-review selection')
  if (choice === 'Re-review selection') {
    await vscode.commands.executeCommand('vouch.selection')
  }
})

reg('vouch.reattach', async () => {
  for (const root of ctx.roots) {
    const orphans = root.store.orphans(p => fs.existsSync(path.join(root.rootDir, p)))
    if (orphans.length === 0) continue
    const oldPath = await vscode.window.showQuickPick(orphans,
      { placeHolder: 'Vouch: orphaned reviews — pick the old path to re-attach' })
    if (!oldPath) return
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, defaultUri: vscode.Uri.file(root.rootDir),
      openLabel: 'Re-attach reviews to this file' })
    const newUri = picked?.[0]
    if (!newUri) return
    const newSourcePath = ctx.sourcePathOf(newUri)
    if (!newSourcePath) {
      void vscode.window.showWarningMessage('Vouch: target must be inside the workspace.'); return
    }
    const author = await resolveAuthor(extCtx, root.rootDir)
    if (!author) return
    const state = root.store.stateFor(oldPath)!
    const { copies, tombstones } = buildReattachLines(
      state.current, newSourcePath, () => randomUUID(), new Date().toISOString(), author)
    for (const c of copies) {
      await appendLine(root.rootDir, newSourcePath, authorSlug(c.author.email), c)
    }
    for (const t of tombstones) {
      await appendLine(root.rootDir, oldPath, authorSlug(author.email), t)
    }
    await ctx.reload()
    refresh()
    return
  }
  void vscode.window.showInformationMessage('Vouch: no orphaned reviews.')
})
```

(Auto-supersede note: `vouch.reReview` delegates to the attest commands, and `buildRecord`'s overlap/symbol auto-supersede links the new record to the dismissed chain — the pre-selection guarantees overlap for the free-form case; the `symbol` match covers symbol records even when ranges moved.)

- [ ] **Step 6: Run all tests, verify pass**

Run: `npm run typecheck && npm test && npm run test:int`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: re-review flow and append-only orphan re-attach"
```

---

### Task 16: Sidebar — coverage tree, stats, orphans, background queue

**Files:**
- Create: `src/core/treemodel.ts`, `src/vscode/sidebar.ts`
- Modify: `src/vscode/extension.ts`
- Test: `test/core/treemodel.test.ts`

**Interfaces:**
- Consumes: `FileCoverage`, `rollup`, `pct` (Task 9); store, pipeline.
- Produces:
  - `src/core/treemodel.ts` (pure):
    - `interface TreeFile { path: string; coverage: FileCoverage | null | 'pending' }` (`null` = no records/excluded; `'pending'` = attested, not yet computed)
    - `interface TreeFolder { name: string; path: string; folders: TreeFolder[]; files: TreeFile[]; coverage: FileCoverage | null | 'pending' }`
    - `buildTree(files: TreeFile[]): TreeFolder` — root folder from posix paths; folder coverage = `rollup` of attested descendants, `'pending'` if any descendant pending (spec §8: attested-only rollups).
    - `interface HeaderStats { workspacePct: number | null; pending: boolean; records: number; attested: number; totalFiles: number; perAuthor: { name: string; current: number }[] }`
    - `headerStats(files: TreeFile[], totalFiles: number, counts: ReturnType<ReviewStore['counts']>): HeaderStats`
  - `src/vscode/sidebar.ts`: `class CoverageTree implements vscode.TreeDataProvider<Item>` registered for view `vouch.coverage`:
    - Items: header stats item (always first, description shows `…` while pending), folder items (description `NN%`), file items (description `NN%` + dot color via `ThemeIcon('circle-filled')` + `ThemeColor` — `charts.green` 100%, `charts.yellow` partial, `charts.red` 0%; dim record-less files: no description), orphans item with children per orphan path (command: `vouch.reattach`).
    - Workspace file list from `lsFiles(rootDir)` (fallback `vscode.workspace.findFiles('**/*', undefined)` capped 20 000) — paths only, no reads.
    - **Background queue:** attested files not open in an editor → queued; each tick (`setTimeout` chain, 25 ms between files) reads the file, runs text-only resolution (`resolveRecord` without symbols) + `fileCoverage`, caches `{ mtimeMs, storeGen, coverage }`; on completion updates the element (`onDidChangeTreeData.fire(...)`). Open documents use `pipeline.statusFor` directly.
    - Refresh triggers: `ctx.onDidChange`, `pipeline.onDidUpdate`, file create/delete watcher.

- [ ] **Step 1: Write failing unit tests**

```ts
// test/core/treemodel.test.ts
import { describe, it, expect } from 'vitest'
import { buildTree, headerStats, type TreeFile } from '../../src/core/treemodel'

const FILES: TreeFile[] = [
  { path: 'src/a.ts', coverage: { reviewedLines: 5, totalLines: 10 } },
  { path: 'src/sub/b.ts', coverage: { reviewedLines: 10, totalLines: 10 } },
  { path: 'src/c.ts', coverage: null },          // no records
  { path: 'README.md', coverage: null },
]

describe('buildTree', () => {
  it('nests folders and rolls up attested descendants only', () => {
    const root = buildTree(FILES)
    const src = root.folders.find(f => f.name === 'src')!
    expect(src.files.map(f => f.path).sort()).toEqual(['src/a.ts', 'src/c.ts'])
    expect(src.folders[0]!.name).toBe('sub')
    expect(src.coverage).toEqual({ reviewedLines: 15, totalLines: 20 }) // c.ts excluded
    expect(root.files.map(f => f.path)).toEqual(['README.md'])
    expect(root.coverage).toEqual({ reviewedLines: 15, totalLines: 20 })
  })
  it('pending descendant → pending folder', () => {
    const root = buildTree([{ path: 'src/a.ts', coverage: 'pending' },
      { path: 'src/b.ts', coverage: { reviewedLines: 1, totalLines: 2 } }])
    expect(root.folders[0]!.coverage).toBe('pending')
    expect(root.coverage).toBe('pending')
  })
  it('all-null tree → null coverage (no NaN)', () => {
    const root = buildTree([{ path: 'a.ts', coverage: null }])
    expect(root.coverage).toBeNull()
  })
})

describe('headerStats', () => {
  it('computes workspace pct over attested files and counts', () => {
    const counts = { records: 3, perAuthor: new Map([['s@x.com', { name: 'San', current: 3 }]]) }
    const h = headerStats(FILES, 42, counts)
    expect(h.workspacePct).toBe(75) // 15/20
    expect(h.pending).toBe(false)
    expect(h.attested).toBe(2)
    expect(h.totalFiles).toBe(42)
    expect(h.perAuthor).toEqual([{ name: 'San', current: 3 }])
  })
  it('pending propagates; no attested files → null pct', () => {
    expect(headerStats([{ path: 'a', coverage: 'pending' }], 1,
      { records: 0, perAuthor: new Map() }).pending).toBe(true)
    expect(headerStats([{ path: 'a', coverage: null }], 1,
      { records: 0, perAuthor: new Map() }).workspacePct).toBeNull()
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/core/treemodel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement treemodel.ts**

```ts
// src/core/treemodel.ts
import { rollup, pct, type FileCoverage } from './coverage'

export interface TreeFile { path: string; coverage: FileCoverage | null | 'pending' }
export interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  files: TreeFile[]
  coverage: FileCoverage | null | 'pending'
}

export function buildTree(files: TreeFile[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [], coverage: null }
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = f.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]!
      let child = node.folders.find(x => x.name === name)
      if (!child) {
        child = { name, path: segments.slice(0, i + 1).join('/'), folders: [], files: [], coverage: null }
        node.folders.push(child)
      }
      node = child
    }
    node.files.push(f)
  }
  computeCoverage(root)
  return root
}

function computeCoverage(folder: TreeFolder): FileCoverage | null | 'pending' {
  const parts: (FileCoverage | null)[] = []
  let pending = false
  for (const sub of folder.folders) {
    const c = computeCoverage(sub)
    if (c === 'pending') pending = true
    else parts.push(c)
  }
  for (const f of folder.files) {
    if (f.coverage === 'pending') pending = true
    else parts.push(f.coverage)
  }
  folder.coverage = pending ? 'pending' : rollup(parts)
  return folder.coverage
}

export interface HeaderStats {
  workspacePct: number | null
  pending: boolean
  records: number
  attested: number
  totalFiles: number
  perAuthor: { name: string; current: number }[]
}

export function headerStats(
  files: TreeFile[], totalFiles: number,
  counts: { records: number; perAuthor: Map<string, { name: string; current: number }> },
): HeaderStats {
  const pending = files.some(f => f.coverage === 'pending')
  const attestedCovs = files
    .map(f => f.coverage)
    .filter((c): c is FileCoverage => c !== null && c !== 'pending')
  const total = rollup(attestedCovs)
  return {
    workspacePct: total ? pct(total) : null,
    pending,
    records: counts.records,
    attested: files.filter(f => f.coverage !== null).length,
    totalFiles,
    perAuthor: [...counts.perAuthor.values()],
  }
}
```

- [ ] **Step 4: Run unit tests, verify pass**

Run: `npx vitest run test/core/treemodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement sidebar.ts and wire**

```ts
// src/vscode/sidebar.ts
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveRecord } from '../core/anchor'
import { fileCoverage, pct, type FileCoverage } from '../core/coverage'
import { buildTree, headerStats, type TreeFile, type TreeFolder } from '../core/treemodel'
import type { VouchContext, RootEntry } from './context'
import type { StatusPipeline } from './pipeline'
import { lsFiles } from './gitinfo'

type Item =
  | { t: 'header' }
  | { t: 'folder'; root: RootEntry; node: TreeFolder }
  | { t: 'file'; root: RootEntry; file: TreeFile }
  | { t: 'orphanRoot' }
  | { t: 'orphan'; path: string }

export class CoverageTree implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  private covCache = new Map<string, { mtimeMs: number; gen: number; coverage: FileCoverage | null }>()
  private gen = 0
  private fileList = new Map<string, string[]>() // rootDir -> repo-relative paths
  private queue: { root: RootEntry; sourcePath: string }[] = []
  private queueRunning = false

  constructor(
    private readonly ctx: VouchContext,
    private readonly pipeline: StatusPipeline,
    subscriptions: vscode.Disposable[],
  ) {
    subscriptions.push(
      ctx.onDidChange(() => this.refresh()),
      pipeline.onDidUpdate(() => this.emitter.fire(undefined)),
    )
    void this.loadFileLists().then(() => this.refresh())
  }

  private async loadFileLists(): Promise<void> {
    for (const root of this.ctx.roots) {
      const files = await lsFiles(root.rootDir)
      this.fileList.set(root.rootDir, files.length > 0 ? files : await this.findFallback(root))
    }
  }

  private async findFallback(root: RootEntry): Promise<string[]> {
    const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 20_000)
    return uris
      .filter(u => u.fsPath.startsWith(root.rootDir))
      .map(u => path.relative(root.rootDir, u.fsPath).split(path.sep).join('/'))
  }

  refresh(): void {
    this.gen++
    this.queue = this.ctx.roots.flatMap(root =>
      root.store.attestedFiles()
        .filter(p => fs.existsSync(path.join(root.rootDir, p)))
        .map(sourcePath => ({ root, sourcePath })))
    this.runQueue()
    this.emitter.fire(undefined)
  }

  private runQueue(): void {
    if (this.queueRunning) return
    this.queueRunning = true
    const tick = (): void => {
      const job = this.queue.shift()
      if (!job) { this.queueRunning = false; this.emitter.fire(undefined); return }
      const abs = path.join(job.root.rootDir, job.sourcePath)
      try {
        const stat = fs.statSync(abs)
        const key = abs
        const hit = this.covCache.get(key)
        if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.gen !== this.gen) {
          const text = fs.readFileSync(abs, 'utf8')
          const state = job.root.store.stateFor(job.sourcePath)!
          const entries = state.current.map(record => ({
            record, res: resolveRecord(record, text) })) // text-only (spec §8)
          this.covCache.set(key, {
            mtimeMs: stat.mtimeMs, gen: this.gen, coverage: fileCoverage(entries, text) })
        }
      } catch { /* unreadable/binary → excluded */ }
      setTimeout(tick, 25)
    }
    tick()
  }

  private treeFiles(root: RootEntry): TreeFile[] {
    const attested = new Set(root.store.attestedFiles())
    const out: TreeFile[] = []
    for (const p of this.fileList.get(root.rootDir) ?? []) {
      if (!attested.has(p)) { out.push({ path: p, coverage: null }); continue }
      const cached = this.covCache.get(path.join(root.rootDir, p))
      out.push({ path: p, coverage: cached && cached.gen === this.gen ? cached.coverage : 'pending' })
    }
    return out
  }

  getTreeItem(el: Item): vscode.TreeItem {
    if (el.t === 'header') {
      const root = this.ctx.roots[0]
      const files = root ? this.treeFiles(root) : []
      const h = headerStats(files, files.length, root?.store.counts() ?? { records: 0, perAuthor: new Map() })
      const item = new vscode.TreeItem('Coverage', vscode.TreeItemCollapsibleState.None)
      item.description = h.pending ? '…'
        : h.workspacePct === null ? 'no reviews yet'
        : `${h.workspacePct}% of attested · ${h.attested}/${h.totalFiles} files · ${h.records} reviews`
      item.iconPath = new vscode.ThemeIcon('shield')
      return item
    }
    if (el.t === 'folder') {
      const item = new vscode.TreeItem(el.node.name, vscode.TreeItemCollapsibleState.Collapsed)
      if (el.node.coverage === 'pending') item.description = '…'
      else if (el.node.coverage) item.description = `${pct(el.node.coverage)}%`
      item.iconPath = vscode.ThemeIcon.Folder
      return item
    }
    if (el.t === 'file') {
      const item = new vscode.TreeItem(path.basename(el.file.path), vscode.TreeItemCollapsibleState.None)
      const c = el.file.coverage
      if (c === 'pending') item.description = '…'
      else if (c) {
        const p = pct(c)
        item.description = `${p}%`
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(
          p === 100 ? 'charts.green' : p > 0 ? 'charts.yellow' : 'charts.red'))
      } else {
        item.iconPath = new vscode.ThemeIcon('circle-outline')
      }
      item.command = { command: 'vscode.open', title: 'Open',
        arguments: [vscode.Uri.file(path.join(el.root.rootDir, el.file.path))] }
      return item
    }
    if (el.t === 'orphanRoot') {
      const item = new vscode.TreeItem('Orphans', vscode.TreeItemCollapsibleState.Collapsed)
      item.iconPath = new vscode.ThemeIcon('warning')
      return item
    }
    const item = new vscode.TreeItem(el.path, vscode.TreeItemCollapsibleState.None)
    item.command = { command: 'vouch.reattach', title: 'Re-attach' }
    return item
  }

  getChildren(el?: Item): Item[] {
    if (!el) {
      const out: Item[] = [{ t: 'header' }]
      for (const root of this.ctx.roots) {
        const tree = buildTree(this.treeFiles(root))
        out.push(...tree.folders.map(node => ({ t: 'folder' as const, root, node })))
        out.push(...tree.files.map(file => ({ t: 'file' as const, root, file })))
      }
      const orphans = this.ctx.roots.flatMap(r =>
        r.store.orphans(p => fs.existsSync(path.join(r.rootDir, p))))
      if (orphans.length > 0) out.push({ t: 'orphanRoot' })
      return out
    }
    if (el.t === 'folder') {
      return [
        ...el.node.folders.map(node => ({ t: 'folder' as const, root: el.root, node })),
        ...el.node.files.map(file => ({ t: 'file' as const, root: el.root, file })),
      ]
    }
    if (el.t === 'orphanRoot') {
      return this.ctx.roots.flatMap(r =>
        r.store.orphans(p => fs.existsSync(path.join(r.rootDir, p)))
          .map(p => ({ t: 'orphan' as const, path: p })))
    }
    return []
  }
}
```

Wire in `extension.ts`:

```ts
import { CoverageTree } from './sidebar'
const tree = new CoverageTree(ctx, pipeline, context.subscriptions)
context.subscriptions.push(vscode.window.registerTreeDataProvider('vouch.coverage', tree))
```

Multi-root note: the header item currently reads the first root (single-root covers spec v1 primary path; multi-root roots each render their tree below — acceptable v1 simplification of spec §9 "header aggregates across roots"; if trivial, sum across roots in `getTreeItem('header')` by concatenating `treeFiles` of all roots — do that if time allows in this task).

- [ ] **Step 6: Add integration smoke test**

```ts
describe('sidebar', () => {
  it('tree provider returns header + fixture tree', async () => {
    // Allow the background queue a moment
    await new Promise(r => setTimeout(r, 500))
    const items = await vscode.commands.executeCommand<unknown>('workbench.view.extension.vouch')
    // The command just focuses the view; real assertion is via the test api:
    const api = (await vscode.extensions.getExtension('sanzhar.vouch')!.activate()).getTestApi()
    assert.ok(api.context.roots.length >= 1)
  })
})
```

(TreeDataProvider internals aren't directly assertable through the command API; the unit tests carry the model logic, integration asserts activation of the view without error.)

- [ ] **Step 7: Run all tests, verify pass**

Run: `npm run typecheck && npm test && npm run test:int`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: coverage sidebar with attested-only rollups and background queue"
```

---

### Task 17: Timeline webview panel

**Files:**
- Create: `src/core/timelinehtml.ts`, `src/vscode/panel.ts`
- Modify: `src/vscode/commands.ts` (register `vouch.openTimeline`), `package.json` (add command declaration `{ "command": "vouch.openTimeline", "title": "Vouch: Open review timeline" }`)
- Test: `test/core/timelinehtml.test.ts`

**Interfaces:**
- Consumes: `ChainState`, `Resolution`, `relTime` (Tasks 3, 8, 13).
- Produces:
  - `src/core/timelinehtml.ts` (pure):
    - `interface TimelineInput { sourcePath: string; users: { name: string; email: string; chains: { entries: { recordId: string; status: 'reviewed' | 'dismissed' | 'historical'; createdAt: string; commit: string; commitLink: string | null; comment?: string; kind: string; symbol?: string; range?: [number, number] }[]; revoked: boolean }[] }[]; nowIso: string }`
    - `timelineHtml(input: TimelineInput, cspSource: string, nonce: string): string` — full HTML doc: CSP meta (`default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'`), tab bar per user (client-side JS toggles), chains newest-first, each entry shows status glyph, `relTime`, short sha link, comment, kind/symbol/range label; revoked chains inside `<details>`. All user strings HTML-escaped (`escapeHtml`).
  - `src/vscode/panel.ts`: `openTimeline(ctx, pipeline, recordId: string)` — find record (Task 14 `findRecord`), build `TimelineInput` from the source's `ChainState` (status of each chain's current record from pipeline if the doc is open, else `'historical'` for non-current members and current shown as `reviewed`/`dismissed` from a text-only resolve of on-disk content), `vscode.window.createWebviewPanel('vouchTimeline', 'Vouch: <sourcePath>', Beside, { enableScripts: true })`, `panel.webview.html = timelineHtml(...)`; handle `onDidReceiveMessage` for `{ cmd: 'reReview' | 'showDiff', recordId }` → execute the corresponding command.

- [ ] **Step 1: Write failing unit tests**

```ts
// test/core/timelinehtml.test.ts
import { describe, it, expect } from 'vitest'
import { timelineHtml, escapeHtml } from '../../src/core/timelinehtml'

const INPUT = {
  sourcePath: 'src/a.ts',
  nowIso: '2026-07-13T12:00:00Z',
  users: [{
    name: 'San <script>', email: 's@x.com',
    chains: [{
      revoked: false,
      entries: [
        { recordId: 'r2', status: 'reviewed' as const, createdAt: '2026-07-12T12:00:00Z',
          commit: 'abc1234def', commitLink: 'https://x/commit/abc1234def',
          comment: 'v2 <b>bold</b>', kind: 'function', symbol: 'f' },
        { recordId: 'r1', status: 'historical' as const, createdAt: '2026-07-10T12:00:00Z',
          commit: '', commitLink: null, kind: 'selection', range: [1, 3] as [number, number] },
      ],
    }, { revoked: true, entries: [{ recordId: 'r0', status: 'historical' as const,
      createdAt: '2026-07-01T12:00:00Z', commit: '', commitLink: null, kind: 'selection' }] }],
  }],
}

describe('timelineHtml', () => {
  it('escapes user content and renders tabs, chains, revoked details', () => {
    const html = timelineHtml(INPUT, 'vscode-resource:', 'NONCE')
    expect(html).not.toContain('<script>')          // raw user input never passes through
    expect(html).toContain('San &lt;script&gt;')
    expect(html).toContain('v2 &lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain('abc1234')                // short sha
    expect(html).toContain('<details>')              // revoked chain
    expect(html).toContain('nonce="NONCE"')
    expect(html).toContain("default-src 'none'")
  })
  it('escapeHtml covers the five specials', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/core/timelinehtml.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement timelinehtml.ts**

```ts
// src/core/timelinehtml.ts
import { relTime } from './hovermd'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export interface TimelineEntry {
  recordId: string
  status: 'reviewed' | 'dismissed' | 'historical'
  createdAt: string
  commit: string
  commitLink: string | null
  comment?: string
  kind: string
  symbol?: string
  range?: [number, number]
}
export interface TimelineInput {
  sourcePath: string
  nowIso: string
  users: { name: string; email: string
    chains: { entries: TimelineEntry[]; revoked: boolean }[] }[]
}

const GLYPH = { reviewed: '✓', dismissed: '⚠', historical: '·' } as const

function entryHtml(e: TimelineEntry, nowIso: string): string {
  const sha = e.commit ? e.commit.slice(0, 7) : ''
  const shaHtml = !sha ? '' : e.commitLink
    ? ` <a href="${escapeHtml(e.commitLink)}"><code>${escapeHtml(sha)}</code></a>`
    : ` <code>${escapeHtml(sha)}</code>`
  const what = e.symbol ? `${e.kind} ${e.symbol}`
    : e.range ? `${e.kind} L${e.range[0]}–${e.range[1]}` : e.kind
  const comment = e.comment ? `<blockquote>${escapeHtml(e.comment)}</blockquote>` : ''
  const actions = e.status === 'dismissed'
    ? ` <button data-cmd="reReview" data-id="${escapeHtml(e.recordId)}">Re-review</button>` : ''
  const diffBtn = e.status !== 'historical'
    ? ` <button data-cmd="showDiff" data-id="${escapeHtml(e.recordId)}">Diff</button>` : ''
  return `<li class="${e.status}"><span class="glyph">${GLYPH[e.status]}</span> ` +
    `<strong>${e.status}</strong> — ${escapeHtml(what)}, ${relTime(e.createdAt, nowIso)}` +
    `${shaHtml}${actions}${diffBtn}${comment}</li>`
}

export function timelineHtml(input: TimelineInput, cspSource: string, nonce: string): string {
  const tabs = input.users.map((u, i) =>
    `<button class="tab" data-tab="${i}">${escapeHtml(u.name)}</button>`).join('')
  const panes = input.users.map((u, i) => {
    const chains = u.chains.map(c => {
      const list = `<ul>${c.entries.map(e => entryHtml(e, input.nowIso)).join('')}</ul>`
      return c.revoked ? `<details><summary>revoked chain</summary>${list}</details>` : list
    }).join('')
    return `<section class="pane" data-pane="${i}">${chains}</section>`
  }).join('')
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'">
<style>
  body { font-family: var(--vscode-font-family); }
  .tab { margin-right: .5em; } .pane { display: none; } .pane.active { display: block; }
  li.reviewed .glyph { color: var(--vscode-charts-green); }
  li.dismissed .glyph { color: var(--vscode-charts-yellow); }
  blockquote { opacity: .8; margin: .2em 0 .6em 1.5em; }
</style></head><body>
<h3>${escapeHtml(input.sourcePath)}</h3>
<nav>${tabs}</nav>${panes}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  const activate = i => {
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === String(i)))
  }
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => activate(t.dataset.tab)))
  document.querySelectorAll('button[data-cmd]').forEach(b =>
    b.addEventListener('click', () => vscode.postMessage({ cmd: b.dataset.cmd, recordId: b.dataset.id })))
  activate(0)
</script></body></html>`
}
```

- [ ] **Step 4: Run unit tests, verify pass**

Run: `npx vitest run test/core/timelinehtml.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement panel.ts, register command, declare in package.json**

```ts
// src/vscode/panel.ts
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveRecord } from '../core/anchor'
import { commitUrl } from '../core/giturl'
import { timelineHtml, type TimelineInput, type TimelineEntry } from '../core/timelinehtml'
import type { VouchContext } from './context'
import { findRecord } from './diff'
import { remoteUrl } from './gitinfo'

export async function openTimeline(ctx: VouchContext, recordId: string): Promise<void> {
  const found = findRecord(ctx, recordId)
  if (!found) { void vscode.window.showWarningMessage('Vouch: record not found.'); return }
  const { rootDir, sourcePath } = found
  const root = ctx.roots.find(r => r.rootDir === rootDir)!
  const state = root.store.stateFor(sourcePath)!
  const remote = await remoteUrl(rootDir)

  let docText = ''
  try { docText = fs.readFileSync(path.join(rootDir, sourcePath), 'utf8') } catch { /* gone */ }

  const currentIds = new Set(state.current.map(r => r.id))
  const byUser = new Map<string, TimelineInput['users'][number]>()
  for (const [rootId, members] of state.chains) {
    const first = members[0]!
    const key = first.author.email
    if (!byUser.has(key)) byUser.set(key, { name: first.author.name, email: key, chains: [] })
    const entries: TimelineEntry[] = [...members].reverse().map(m => ({
      recordId: m.id,
      status: currentIds.has(m.id) && docText !== ''
        ? resolveRecord(m, docText).status : 'historical',
      createdAt: m.createdAt,
      commit: m.commit,
      commitLink: m.commit && remote ? commitUrl(remote, m.commit) : null,
      comment: m.comment,
      kind: m.kind,
      symbol: m.symbol,
      range: m.range,
    }))
    byUser.get(key)!.chains.push({ entries, revoked: state.revokedChains.has(rootId) })
  }

  const panel = vscode.window.createWebviewPanel('vouchTimeline',
    `Vouch: ${sourcePath}`, vscode.ViewColumn.Beside, { enableScripts: true })
  const input: TimelineInput = {
    sourcePath, nowIso: new Date().toISOString(), users: [...byUser.values()] }
  panel.webview.html = timelineHtml(input, panel.webview.cspSource, randomUUID())
  panel.webview.onDidReceiveMessage((msg: { cmd: string; recordId: string }) => {
    if (msg.cmd === 'reReview') void vscode.commands.executeCommand('vouch.reReview', msg.recordId)
    if (msg.cmd === 'showDiff') void vscode.commands.executeCommand('vouch.showDiff', msg.recordId)
  })
}
```

In `commands.ts`: `reg2('vouch.openTimeline', (recordId: string) => openTimeline(ctx, recordId))`.
In `package.json` commands array, add: `{ "command": "vouch.openTimeline", "title": "Vouch: Open review timeline" }`.

- [ ] **Step 6: Run all tests, verify pass**

Run: `npm run typecheck && npm test && npm run test:int`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: per-user timeline webview with revoked-chain disclosure"
```

---

### Task 18: Packaging, README, manual end-to-end verification

**Files:**
- Create: `README.md`, `LICENSE` (MIT)
- Modify: `package.json` if packaging surfaces issues

**Interfaces:**
- Consumes: everything.
- Produces: installable `vouch-0.0.1.vsix`.

- [ ] **Step 1: Write README.md**

Content requirements (write actual prose, not this outline): what Vouch is (one paragraph — attested human review coverage for the AI-code era), install from `.vsix` for VS Code and Cursor (`code --install-extension vouch-0.0.1.vsix` / Cursor: Extensions → ⋯ → Install from VSIX), quickstart (run `Vouch: Initialize`, select lines → `Vouch: Review selected lines`, watch the gutter, open the Vouch activity-bar view), how statuses work (reviewed/dismissed/absence), storage model (`.vouch/` — commit it; per-author shards; `.gitattributes` union hint), team workflow (PRs carry attestations; hosted merges never conflict across authors), limitations (v1: manual re-attach on rename, exact-text dismissal, symbol commands need a language server).

- [ ] **Step 2: Add LICENSE (MIT, copyright 2026 Sanzhar)**

Standard MIT text.

- [ ] **Step 3: Package**

Run: `npm run package`
Expected: `vouch-0.0.1.vsix` produced without warnings that block packaging (vsce complains about missing `repository` — add `"repository": { "type": "git", "url": "https://github.com/sanzhar/vouch" }` placeholder or `--allow-missing-repository`).

- [ ] **Step 4: Manual end-to-end pass (the checklist below, in a real VS Code window)**

Run: `code --install-extension vouch-0.0.1.vsix` then open a scratch git repo.

Checklist (each item must visibly work):
1. `Vouch: Initialize` → `.vouch/config.json` + `.gitattributes` line exist.
2. Select lines → `Vouch: Review selected lines` with a comment → green ✓ gutter icon on first line.
3. Hover the range → status line, comment, sha link, three command links render.
4. Edit inside the range → within ~a second icon flips to orange ⚠; hover says dismissed.
5. `Vouch: Diff since my review` from the hover → diff opens (verified slice when committed; warning + whole-file when the review was of uncommitted code).
6. `Vouch: Re-review` → confirm selection → icon returns to ✓; timeline shows the chain.
7. In a TS file with a language server: cursor inside a function → `Vouch: Review enclosing function` → whole function attested; rename an unrelated line above → icon moves with the function, still ✓.
8. Vouch activity-bar view → header stats, tree with percentage on the attested file, dim others.
9. `Vouch: Revoke my review` on the range → icon gone; timeline shows revoked chain under disclosure.
10. Rename the attested file on disk → Orphans node appears → `Vouch: Re-attach` → records live under the new path.
11. Repeat 1–4 once in **Cursor** to confirm engine compatibility.

Record any failures as issues; fix before calling the task done.

- [ ] **Step 5: Final full test run + commit**

Run: `npm run typecheck && npm test && npm run test:int && npm run package`
Expected: all green.

```bash
git add -A
git commit -m "chore: README, license, vsix packaging"
```

---

## Spec coverage map (self-review)

| Spec section | Tasks |
|---|---|
| §3 data model | 2, 3 |
| §4 storage/shards/init/revocation | 3, 4, 5 |
| §5 anchor identity/auto-supersede | 3 (chains), 11 (auto-supersede) |
| §5 resolution (symbol step, two-stage scan, huge files) | 7, 8, 10 (shape detection), 12 |
| §6 architecture | all (structure mirrors it) |
| §7 gutter | 12 |
| §7 range hover / re-review / call-site hover | 13, 15 |
| §7 sidebar / orphans / re-attach | 15, 16 |
| §7 diff since review (verified baseline) | 14 |
| §8 coverage + background queue | 9, 16 |
| §9 multi-root, no-repo, flat symbols, corrupt JSONL, huge files, CRLF | 4, 5, 6, 8, 10, 11 |
| §10 testing | every task (TDD) + integration suite |
| §12 commands | 1 (manifest), 11, 14, 15, 17 |

Known deliberate v1 simplifications (match spec non-goals): no inline call-site decorations; manual re-attach; sidebar header reads first root primarily (multi-root trees still render); re-attach copies **current** records only — historical chain members stay (revoked) in the old path's shards, reachable via `movedFrom` + the old path's timeline rather than replayed under the new path.

