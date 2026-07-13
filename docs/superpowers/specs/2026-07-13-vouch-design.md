# Vouch — Design Spec

**Date:** 2026-07-13
**Status:** Approved pending user review

## 1. Overview

Vouch is a VS Code extension (Cursor-compatible) for human-authored review coverage. AI writes large volumes of code; humans must attest they actually reviewed it. Vouch lets a reviewer mark any span of code — a selection, function, class, or whole file — as reviewed. The attestation is tied to the exact text hash of the span plus the commit at review time. When the code changes, the attestation is automatically dismissed, and this is visible everywhere: gutter icons, hovers at call sites, and a coverage sidebar. Review records live in a versioned `.vouch/` dot-folder, so the whole team shares review state through git — like test coverage, but for human review.

### Goals

- Mark arbitrary line ranges (free-form) as reviewed; function/class/file marking are conveniences that snap the selection to a symbol range.
- Auto-dismiss reviews when the underlying text changes (exact-text hash).
- Show status at a glance: gutter icon per reviewed range, hover timeline, call-site status via hover.
- Show "what changed since my review" as a diff.
- Coverage sidebar: workspace file tree with per-file/per-folder review percentage and summary stats.
- Multi-user: records keyed by git identity; timeline shows per-user tabs.
- Storage merges cleanly across contributors.

### Non-goals (v1)

- No GitHub/GitLab API integration or auth (identity is `git config`).
- No always-on inline decorations at call sites (hover only).
- No automatic re-attachment of records across file renames (manual re-attach command only).
- No line-by-line threaded discussions (single comment per record).
- No enforcement (CI gates, required-review policies) — v2+ territory.

## 2. Decisions made during brainstorming

| Question | Decision |
|---|---|
| Symbol detection | LSP `DocumentSymbol` provider (`vscode.executeDocumentSymbolProvider`). No bundled parsers. |
| Hash strictness | Exact text of the range. Any edit — whitespace, comments — dismisses. |
| Identity | `git config user.name` / `user.email`. No GitHub API. |
| Anchoring | Text+symbol anchor: hash + last-known range + optional symbol path. Relocate via symbol lookup, fall back to exact-text search. |
| Review granularity | Free-form line ranges are the primitive; function/class/file are snapping conveniences. |
| Call-site status | HoverProvider + `executeDefinitionProvider`; status line only, no timeline. |
| Name | **Vouch** — `.vouch/` folder, `vouch.*` commands. |
| V1 scope | Core marking + gutter + dismiss, hover timeline + diff, coverage sidebar, call-site hover status. |

## 3. Data model

One review record:

```jsonc
{
  "id": "uuid-v4",
  "author": { "name": "Sanzhar", "email": "sendwichmj@gmail.com" }, // from git config at creation
  "createdAt": "2026-07-13T12:00:00Z",
  "commit": "abc1234def",           // HEAD sha at review time; basis for web link + diff
  "kind": "function",               // "selection" | "function" | "class" | "file" — how it was created
  "symbol": "AuthService/login",    // optional symbol path (DocumentSymbol names joined with "/")
  "range": [120, 154],              // last-known 1-based inclusive line range; absent for kind=file
  "hash": "sha256:<hex>",           // exact text of the range (or whole file for kind=file) at review time
  "comment": "checked error paths", // optional free text
  "supersedes": "prev-uuid"         // optional — links re-review to the dismissed record it replaces
}
```

Notes:

- **Status is never stored.** It is derived at render time (see §5). Storing it would rot instantly and create merge conflicts.
- `range` uses lines, not offsets — human-meaningful, survives JSONL inspection, and the hash is the real integrity check.
- The hashed text is the raw document text of the range, exactly as on disk (including line endings as normalized by VS Code's document — see §9 edge cases).
- `supersedes` chains records: latest record in a chain represents that author's current attestation for that anchor.

## 4. Storage — the `.vouch/` folder

```
.vouch/
  config.json                     # { "schemaVersion": 1 }
  reviews/
    src/auth/service.ts.jsonl     # mirrors source path; one record per line, append-only
```

- **JSONL, append-only.** The extension only ever appends lines; it never rewrites files (except explicit "purge history" maintenance command, v2).
- **Merging:** `vouch init` writes `.vouch/reviews/**/*.jsonl merge=union` into `.gitattributes`. Union merge concatenates both sides' appended lines. Duplicate lines are possible after merges; the store dedupes by `id` at load time.
- **Deleting/undoing:** "unvouch" appends a tombstone record `{ "id": ..., "revokes": "<uuid>", "author": ..., "createdAt": ... }`. Load-time resolution drops revoked records. Keeps append-only property.
- `config.json` carries `schemaVersion` for forward migration.

## 5. Status resolution (anchor engine)

For each record against the current document text:

1. **Symbol path present?** Run `executeDocumentSymbolProvider`, resolve the symbol path. If found: hash the symbol's current full range text. Match → `reviewed` (record's effective range = symbol's current range, even if it moved). Mismatch → `dismissed` (anchored at the symbol's current range for display).
2. **No symbol / symbol not found:** exact-text search for the originally hashed text in the document. Found → `reviewed` at the found range; if multiple matches, the one nearest the last-known range wins. Not found → `dismissed`, displayed at last-known range clamped to the document length.
3. **kind=file:** hash entire document; match → `reviewed`, else `dismissed`.

Free-form relocation does **not** store or need the original source text. It scans the document with a sliding window of the record's original line count, hashing each window until one matches the stored hash (window hashes computed incrementally, so the scan is O(document size)). This keeps `.vouch/` records small and avoids duplicating source code inside the repo.

- Per-user, per-anchor: the latest record (by `createdAt`) in a `supersedes` chain is that user's current attestation. Older records render only in the timeline.
- A range is "live-reviewed" for coverage purposes if **any** user's current attestation on it resolves to `reviewed`.

Resolution runs per open/changed file (debounced ~300 ms) and lazily for sidebar coverage (see §8).

## 6. Extension architecture

```
src/
  extension.ts          # activation, wiring, disposables
  store/
    reviewStore.ts      # load .vouch/reviews/*.jsonl → in-memory index (by file); dedupe by id;
                        # resolve supersedes/revokes chains; FileSystemWatcher on .vouch/ (git pull refresh)
    writer.ts           # append records; vouch init (.vouch/, config.json, .gitattributes entry)
  anchor/
    hasher.ts           # sha256 over range text
    symbols.ts          # executeDocumentSymbolProvider wrapper; symbol-path build/resolve
    anchorEngine.ts     # §5 algorithm; window-scan relocation for free-form records
  status/
    statusResolver.ts   # record set + document → per-record {status, effectiveRange}; per-file coverage %
  ui/
    gutter.ts           # TextEditorDecorationType (reviewed / dismissed icons) on first line of effective range
    hoverProviders.ts   # (a) range hover: timeline markdown, per-user sections, commit link, diff command link
                        # (b) call-site hover: executeDefinitionProvider → target's live status one-liner
    reviewPanel.ts      # webview panel: full timeline, per-user tabs, comment display, re-review button
    sidebar.ts          # TreeDataProvider: workspace tree + coverage %, stats header node; orphan records node
    commands.ts         # vouch.selection / vouch.function / vouch.class / vouch.file / vouch.reReview /
                        # vouch.unvouch / vouch.showDiff / vouch.openCommitOnWeb / vouch.init / vouch.reattach
  git/
    gitInfo.ts          # user.name/email, HEAD sha, remote URL → https link builder (github/gitlab/bitbucket)
    diff.ts             # git show <commit>:<path> → TextDocumentContentProvider → vscode.diff slice-vs-slice
```

**Data flow:** document open/edit (debounced) → `anchorEngine` relocates that file's records → `statusResolver` computes statuses + coverage → `gutter` and `sidebar` refresh. Hover computation is on-demand only. `.vouch/` watcher triggers store reload → same refresh path.

**Activation:** `onStartupFinished` (cheap store load) — decorations attach when an editor with records becomes visible. Commands declared in `package.json` with context-menu contributions (editor context + editor/title).

**Cursor compatibility:** stable VS Code APIs only (decorations, hovers, tree views, webviews, commands, FS watcher). No proposed APIs. Engine pin conservative (e.g. `^1.85.0`) so current Cursor accepts it.

## 7. UI details

### Gutter

- One icon at the first line of each record's effective range: ✓ (reviewed, green) / ⚠ (dismissed, orange). Unreviewed code has no icon — absence is the third status.
- Overlapping records: one icon per distinct anchor; the strongest status shown is `dismissed` (needs attention beats reviewed).

### Range hover + review panel

- Hovering anywhere in an attested range shows: per-user status lines, latest comment, relative time, short commit sha (click → web), links: "Open timeline", "Diff since review", "Re-review".
- "Open timeline" opens the webview panel: tabs per user, each tab a chronological chain (reviewed → dismissed → re-reviewed…), full comments, commit links.

### Call-site hover

- HoverProvider registered for `{ scheme: "file" }` (all languages). On hover over an identifier: `executeDefinitionProvider`; if the target file has records overlapping the target range, append one line per distinct author's current status: `Vouch: ✓ reviewed — sanzhar, 2d ago` or `Vouch: ⚠ dismissed (changed since review) — sanzhar`. Nothing appended when unreviewed (silence = not reviewed).
- Definition + store lookups are async and bounded (<50 ms budget; bail silently on timeout) so hovers never lag.

### Sidebar (activity bar view "Vouch")

- Header stats node: workspace coverage %, counts of reviewed/dismissed records, per-user totals.
- File tree of the workspace (respects `.gitignore`/`files.exclude`); each file node suffixed with coverage % and a color dot (0 / partial / 100). Folders roll up child percentages weighted by line counts. Unreviewed files render dim — visible but quiet.
- "Orphans" node lists records whose source file no longer exists (rename/delete) with a "Re-attach…" action (pick new file; records move, then re-resolve).

### Diff since review

- From hover/panel: `git show <commit>:<file>` into a read-only virtual document; slice the old text to the record's stored range; slice current doc to the effective range; open `vscode.diff` titled "Vouch: since <shortsha>". If relocation is ambiguous or the slice fails, fall back to whole-file diff.

## 8. Coverage computation

- Per file: union of effective ranges of live-reviewed records ÷ total lines. `kind=file` reviewed → 100 %.
- Closed files can't run LSP symbol relocation. Sidebar coverage for closed files uses text-based resolution only (hash windows against on-disk content, via workspace FS read) — correct for the dominant case; symbol-moved-but-unchanged code still hash-matches by text scan. Computed lazily per visible tree node and cached; invalidated by file mtime + store changes.

## 9. Edge cases & error handling

- **File renamed:** records keyed by old path → appear in sidebar "Orphans"; manual re-attach in v1; follow git renames in v2.
- **No language server / no symbols:** function/class commands degrade to selection-based records (no symbol path); relocation still works via text scan.
- **Multiple identical text matches:** nearest to last-known range wins.
- **Not a git repo:** everything works except commit capture, web links, and diff-since-review; identity falls back to a one-time prompt stored in extension settings; `commit` field empty.
- **Line endings:** hash normalizes CRLF→LF so checkouts on different `core.autocrlf` settings don't mass-dismiss.
- **Corrupt JSONL line:** skip, log to output channel, warn once per session. Never crash the store.
- **Huge files (>20 k lines):** skip window-scan relocation (symbol/exact-range check only) to bound CPU; note in hover.
- **Concurrent editors:** store is single-writer per window; append with `fs.appendFile`; watcher reconciles cross-window.

## 10. Testing

- **Unit (vitest or mocha, plain Node):** hasher (CRLF normalization), JSONL parse/dedupe/supersedes/revokes resolution, window-scan relocation fixtures (code moved / edited / deleted / duplicated), coverage math.
- **Integration (`@vscode/test-electron`):** fixture workspace; run vouch commands; assert decoration sets, tree data, hover contents; simulate edit → dismissal; simulate append from "another user" → merge/dedupe.
- TDD throughout implementation (superpowers flow).

## 11. V2 backlog

- Follow git renames automatically; auto re-attach.
- Inline (GitLens-style) call-site decorations, toggleable.
- CI/enforcement: fail PR if changed lines lack live review (CLI companion reading `.vouch/`).
- GitHub handle mapping for display/links.
- Line-by-line threaded comments.
- Purge/compact history command.
- Marketplace publish pipeline (extension is local `.vsix` first).

## 12. Naming & commands

| Command | Title |
|---|---|
| `vouch.init` | Vouch: Initialize in workspace |
| `vouch.selection` | Vouch: Review selected lines |
| `vouch.function` | Vouch: Review enclosing function |
| `vouch.class` | Vouch: Review enclosing class |
| `vouch.file` | Vouch: Review entire file |
| `vouch.reReview` | Vouch: Re-review (after dismissal) |
| `vouch.unvouch` | Vouch: Revoke my review |
| `vouch.showDiff` | Vouch: Diff since my review |
| `vouch.openCommitOnWeb` | Vouch: Open review commit on web |
| `vouch.reattach` | Vouch: Re-attach orphaned reviews |

Tech stack: TypeScript, esbuild bundling, `@vscode/vsce` packaging. No runtime dependencies beyond Node built-ins (`crypto`, `fs`) and the VS Code API; git access via child_process (no libgit2).
