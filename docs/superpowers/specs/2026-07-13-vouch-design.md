# Vouch — Design Spec

**Date:** 2026-07-13
**Status:** Approved pending user review (rev 2 — post adversarial review, 14 findings fixed)

## 1. Overview

Vouch is a VS Code extension (Cursor-compatible) for human-authored review coverage. AI writes large volumes of code; humans must attest they actually reviewed it. Vouch lets a reviewer mark any span of code — a selection, function, class, or whole file — as reviewed. The attestation is tied to the exact text hash of the span plus the commit at review time. When the code changes, the attestation is automatically dismissed, and this is visible everywhere: gutter icons, hovers at call sites, and a coverage sidebar. Review records live in a versioned `.vouch/` dot-folder, so the whole team shares review state through git — like test coverage, but for human review.

### Goals

- Mark arbitrary line ranges (free-form) as reviewed; function/class/file marking are conveniences that snap the selection to a symbol range.
- Auto-dismiss reviews when the underlying text changes (exact-text hash).
- Show status at a glance: gutter icon per reviewed range, hover timeline, call-site status via hover.
- Show "what changed since my review" as a diff.
- Coverage sidebar: workspace file tree with review percentage for attested files and summary stats.
- Multi-user: records keyed by git identity; timeline shows per-user tabs.
- Storage merges cleanly across contributors — including PRs merged via the GitHub/GitLab web UI.

### Non-goals (v1)

- No GitHub/GitLab API integration or auth (identity is `git config`).
- No always-on inline decorations at call sites (hover only).
- No automatic re-attachment of records across file renames (manual re-attach command only).
- No line-by-line threaded discussions (single comment per record).
- No enforcement (CI gates, required-review policies) — v2+ territory.
- No baseline snapshots of reviewed text (diff-since-review degrades gracefully when the reviewed text was never committed — see §7).

## 2. Decisions made during brainstorming

| Question           | Decision                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Symbol detection   | LSP symbol provider (`vscode.executeDocumentSymbolProvider`), hierarchical `DocumentSymbol` shape only (see §5). No bundled parsers.                                              |
| Hash strictness    | Exact text of the range (CRLF→LF normalized). Any edit — whitespace, comments — dismisses.                                                                                        |
| Identity           | `git config user.name` / `user.email`. No GitHub API.                                                                                                                             |
| Anchoring          | Text+symbol anchor: hash + last-known range + optional symbol path. Relocate via symbol lookup, fall back to text search (two-stage: first-line-hash prefilter, SHA-256 confirm). |
| Review granularity | Free-form line ranges are the primitive; function/class/file are snapping conveniences.                                                                                           |
| Call-site status   | HoverProvider + `executeDefinitionProvider`; status line only, no timeline.                                                                                                       |
| Name               | **Vouch** — `.vouch/` folder, `vouch.*` commands.                                                                                                                                 |
| V1 scope           | Core marking + gutter + dismiss, hover timeline + diff, coverage sidebar, call-site hover status.                                                                                 |

## 3. Data model

One review record:

```jsonc
{
  "id": "uuid-v4",
  "author": { "name": "Sanzhar", "email": "sendwichmj@gmail.com" }, // from git config at creation
  "createdAt": "2026-07-13T12:00:00Z",
  "commit": "abc1234def", // HEAD sha at review time; basis for web link + diff (may not contain the reviewed text — see "dirty")
  "dirty": true, // true if the file differed from HEAD at review time (working tree or index)
  "kind": "function", // "selection" | "function" | "class" | "file" — how it was created
  "symbol": "AuthService/login", // optional symbol path (hierarchical DocumentSymbol names joined with "/")
  "range": [120, 154], // last-known 1-based inclusive line range; absent for kind=file
  "hash": "sha256:<hex>", // exact text of the range (or whole file for kind=file) at review time, CRLF→LF normalized
  "headHash": "sha256:<hex>", // hash of the range's FIRST line — prefilter for text-scan relocation (§5); absent for kind=file
  "comment": "checked error paths", // optional free text
  "supersedes": ["prev-uuid"], // optional — uuids of same-user records this record replaces (see anchor identity, §5)
  "movedFrom": "old-uuid", // optional — set by re-attach (§7); original author/createdAt preserved on the copy
}
```

Tombstone record (revocation):

```jsonc
{
  "id": "uuid-v4",
  "author": { ... },                // who revoked
  "createdAt": "...",
  "revokes": "target-uuid",         // kills the ENTIRE supersedes-chain containing target (see §4)
  "reason": "unvouch"               // "unvouch" | "moved" (re-attach); "moved" adds "movedTo": "<new repo-relative path>"
}
```

Notes:

- **Status is never stored.** It is derived at render time (see §5). Storing it would rot instantly and create merge conflicts.
- `range` uses lines, not offsets — human-meaningful, survives JSONL inspection; the hash is the real integrity check. The stored range is a display/tie-break hint, not assumed fresh.
- Hash input is the document text of the range with line endings normalized CRLF→LF, so checkouts with different `core.autocrlf` don't mass-dismiss.
- `supersedes` chains records; the resolution rule is in §5.

## 4. Storage — the `.vouch/` folder

Location: **git repository root** (so record paths are stable no matter which subfolder is opened as the workspace). If not a git repo, the workspace folder root. In multi-root workspaces each root resolves its own `.vouch/` independently (see §9).

```
.vouch/
  config.json                                # { "schemaVersion": 1 }
  reviews/
    src/auth/service.ts/                     # directory mirroring the repo-relative source path
      a1b2c3d4.jsonl                         # ONE FILE PER AUTHOR: slug = first 8 hex of sha256(author email)
```

- **Per-author shards.** Two different authors never write the same file, so concurrent PRs merge cleanly **even on hosted platforms (GitHub/GitLab web merges), which do not honor `.gitattributes` merge drivers** (verified: `git merge-tree` — the plumbing forges use — ignores in-tree attributes). Same-author-on-two-branches conflicts remain possible but rare; for those, `vouch init` also writes `.vouch/reviews/** merge=union` to `.gitattributes` (honored by local merges/rebases) and conflict resolution is always "take both lines".
- **JSONL, append-only.** The extension only ever appends lines; it never rewrites or deletes files (explicit "purge history" maintenance command is v2). Duplicate lines after merges are possible; the store dedupes by `id` at load time.
- **Revocation semantics:** a tombstone whose `revokes` targets any record kills the **entire supersedes-chain** that record belongs to (all records reachable via `supersedes` links in either direction). Rationale: "Revoke my review" must never resurrect an older attestation in the chain. Revoked chains are hidden from gutter/coverage; the timeline can show them under a "revoked" disclosure.
- `config.json` carries `schemaVersion` for forward migration.

## 5. Status resolution (anchor engine)

**Anchor identity.** All of a user's records connected via `supersedes` links form one _anchor chain_. The current attestation of a chain is its latest non-revoked record by `createdAt` (union-merge forks resolve by timestamp). To prevent parallel chains for the same code: **every vouch command auto-supersedes** — the new record's `supersedes` lists the ids of the same user's current records it absorbs. The trigger is full enclosure of the old scope (equal ranges and same symbol count; a file review encloses everything), never partial overlap - see [ADR 0001](../../adr/0001-supersede-on-enclosure-only.md). Running "Vouch: Review enclosing function" twice therefore yields one chain, not two icons.

**Resolving one current record against the current document:**

1. **Symbol path present?** Run `executeDocumentSymbolProvider`. The command returns `DocumentSymbol[] | SymbolInformation[]`; only the hierarchical `DocumentSymbol` shape is trusted (flat `SymbolInformation` has no children and its range may cover only the name — treat as "no usable symbols" and go to step 2). Resolve the path; if found, hash the symbol's current full range text. Match → `reviewed` at the symbol's current range (icon follows moved code). Mismatch → **do not dismiss yet**; fall through to step 2 (the reviewed text may have moved elsewhere, e.g. rename).
2. **Text scan (free-form or symbol fallback).** Two stages, since SHA-256 cannot roll: (a) hash every line of the document once — O(N); collect candidate positions where the line hash equals the record's `headHash`; (b) for each candidate, hash the window of the record's original line count and compare to `hash`. Found → `reviewed` at the found range; multiple matches → nearest to last-known `range` wins. Not found → `dismissed`, displayed at the last-known range clamped to document length. Worst case (many identical first lines) is O(N·L); bounded by the §9 huge-file cap and by per-file caching keyed to document version.
3. **kind=file:** hash entire document; match → `reviewed`, else `dismissed`.

- A range is "live-reviewed" for coverage purposes if **any** user's current attestation on it resolves to `reviewed`.
- Resolution runs per open/changed file (debounced ~300 ms, cached by document version) and lazily for sidebar coverage (§8).

## 6. Extension architecture

```
src/
  extension.ts          # activation, wiring, disposables
  store/
    reviewStore.ts      # load .vouch/reviews/**/*.jsonl → in-memory index (by file); dedupe by id;
                        # resolve supersedes-chains + chain-wide revokes; FileSystemWatcher on .vouch/ (git pull refresh)
    writer.ts           # append records to the current author's shard; vouch init (.vouch/, config.json, .gitattributes entry)
  anchor/
    hasher.ts           # sha256 over CRLF→LF-normalized text; per-line hashing for scan prefilter
    symbols.ts          # executeDocumentSymbolProvider wrapper; shape detection; symbol-path build/resolve
    anchorEngine.ts     # §5 algorithm: symbol step + two-stage text scan; per-document-version cache
  status/
    statusResolver.ts   # record set + document → per-record {status, effectiveRange}; per-file coverage
  ui/
    gutter.ts           # TextEditorDecorationType (reviewed/dismissed) on first line of effective range (line 1 for kind=file)
    hoverProviders.ts   # (a) range hover: timeline markdown, commit link, diff/re-review command links
                        # (b) call-site hover: cached executeDefinitionProvider → target's precomputed status one-liner
    reviewPanel.ts      # webview panel: full timeline, per-user tabs, comments, revoked-chain disclosure, re-review button
    sidebar.ts          # TreeDataProvider: workspace tree + coverage for attested files, stats header, orphans node
    commands.ts         # vouch.selection / vouch.function / vouch.class / vouch.file / vouch.reReview /
                        # vouch.unvouch / vouch.showDiff / vouch.openCommitOnWeb / vouch.init / vouch.reattach
  git/
    gitInfo.ts          # repo root discovery, user.name/email, HEAD sha, dirty check (diff vs HEAD for one path),
                        # remote URL → https link builder (github/gitlab/bitbucket)
    diff.ts             # git show <commit>:<path> → TextDocumentContentProvider → vscode.diff; baseline verification (§7)
```

**Data flow:** document open/edit (debounced) → `anchorEngine` relocates that file's records → `statusResolver` computes statuses + coverage → `gutter` and `sidebar` refresh. Hover computation is on-demand only and reads precomputed state. `.vouch/` watcher triggers store reload → same refresh path.

**Activation:** `onStartupFinished` (cheap store load — read only `.vouch/`, no source files). Commands declared in `package.json` with context-menu contributions.

**Cursor compatibility:** stable VS Code APIs only (decorations, hovers, tree views, webviews, commands, FS watcher). No proposed APIs. Engine pin conservative (e.g. `^1.85.0`).

## 7. UI details

### Gutter

- One icon at the first line of each current record's effective range (line 1 for `kind=file`): ✓ (reviewed, green) / ⚠ (dismissed, orange). Unreviewed code has no icon — absence is the third status.
- Same-user enclosed reviews are collapsed by auto-supersede (§5); partially overlapping ones coexist as peers (ADR 0001). Different users' records on the same line render one icon; `dismissed` wins visually (needs attention beats reviewed); hover lists every author's status.

### Range hover + review panel

- Hovering anywhere in an attested range shows: per-user status lines, latest comment, relative time, short commit sha (click → web), links: "Open timeline", "Diff since review", "Re-review".
- "Open timeline" opens the webview panel: tabs per user, each tab the chronological anchor chain (reviewed → dismissed → re-reviewed…), full comments, commit links, revoked chains behind a disclosure.

### Re-review (`vouch.reReview`)

- **Symbol-anchored record:** re-attests the symbol's current full range (no selection needed).
- **Free-form record:** requires an explicit selection. Invoked from hover/panel, the command pre-selects the record's displayed effective range and asks the user to confirm or adjust before writing. New record `supersedes` the old chain; comment is prompted anew (old comments remain in the timeline).

### Call-site hover

- HoverProvider registered for `{ scheme: "file" }`. On hover over an identifier: `executeDefinitionProvider` (results cached by `(uri, position, document version)`); if the target file has records overlapping the target range, append one line per author's current status: `Vouch: ✓ reviewed — sanzhar, 2d ago` / `Vouch: ⚠ dismissed (changed since review) — sanzhar`. Nothing appended when unreviewed.
- Budget 400 ms raced against the hover's own `CancellationToken`; on timeout return undefined (note: a timeout renders like "unreviewed" — acceptable, hover retry is cheap and cached). Short-circuit before calling the command when the store has zero records. The hover path serves only precomputed/cached statuses — never FS reads or window scans. (`executeDefinitionProvider` accepts no CancellationToken; the race abandons, not cancels, the LS request — hence the cache.) Never call `executeHoverProvider` from inside a HoverProvider (recursion).

### Sidebar (activity bar view "Vouch")

- Header stats: workspace coverage % **over attested files** (see §8), reviewed/dismissed record counts, per-user totals, and "N attested / M total files" (M from a file count, no reads). Shows `…` while the background computation fills in.
- File tree of the workspace (respects `files.exclude` + `git ls-files` for gitignore semantics); **only files that have records get a percentage and color dot** (0/partial/100). Record-less files render dim with no stats — visible but free (rendering them requires no file reads). Folders roll up over attested descendant files only.
- "Orphans" node lists records whose source file no longer exists, with "Re-attach…".

### Re-attach (append-only mechanics)

Per-file, v1: user picks the new path. For every record of the orphaned file (all authors — mechanical relocation, authorship preserved): append a copy to the new path's shard (fresh `id`, original `author`/`createdAt`/`comment` preserved, `movedFrom: <old-id>`), and append a `reason:"moved"` tombstone (with `movedTo`) to the old path. Timeline follows `movedFrom` links so history survives the move. No file is ever rewritten.

### Diff since review

- Baseline = `git show <commit>:<file>` sliced to the record's stored range — **used only if the slice's hash equals the record's `hash`** (the reviewed text may never have been committed: `dirty` records, or review-then-commit flows where `commit` predates the content). On hash match → `vscode.diff` old-slice vs current effective range, titled "Vouch: since <shortsha>".
- On mismatch (or `dirty: true` and no match): whole-file diff `<commit>:<file>` vs current file, with a warning banner "reviewed text was not in commit <shortsha> — showing nearest baseline". V2 may add opt-in text snapshots for exact baselines.

## 8. Coverage computation

- **Per attested file:** union of effective ranges of live-reviewed records ÷ total lines. `kind=file` reviewed → 100 %.
- **Line-count convention (one rule everywhere):** normalize CRLF→LF; line count = number of `\n`-separated segments, where a trailing newline does **not** add a segment (`"a\nb\n"` = 2 lines). Open documents use the same computation over `document.getText()` — never mix conventions.
- **Empty files** (0 lines after convention): excluded from coverage math entirely (no percentage, excluded from rollups — avoids 0/0 = NaN poisoning folder rollups).
- **Binary/unreadable files:** excluded from coverage and rollups; render dim like record-less files.
- **Rollups & header:** computed **only over attested files** (files with ≥1 non-revoked record). Folder % = reviewed lines ÷ total lines summed over attested descendant files (raw line sums, not averaged percentages). This bounds I/O to record-bearing files — no full-workspace read storm.
- Closed files can't run LSP symbol relocation; their resolution uses the §5 text-scan only, against on-disk content. Computed in a background queue after activation, cached keyed by file mtime + store state; tree shows `…` until filled. Invalidated by file/store changes.

## 9. Edge cases & error handling

- **Multi-root workspaces:** each workspace folder operates independently — own `.vouch/` (at its git repo root, §4), own git identity/HEAD, own watcher. Sidebar groups per root (VS Code's tree does this naturally); header stats aggregate across roots. `vouch.init` targets the root of the active editor's file. Files outside any workspace folder can't be vouched (info message).
- **Workspace folder ≠ repo root** (opened a subfolder): `.vouch/` and record paths stay repo-root-relative — records created from any subfolder-opened window agree.
- **File renamed:** records keyed by old path → sidebar "Orphans"; manual re-attach in v1 (§7); follow git renames in v2.
- **No language server / flat-shape symbols only:** function/class commands degrade to selection-based records (no symbol path); relocation via text scan.
- **Multiple identical text matches:** nearest to last-known range wins.
- **Not a git repo:** works minus commit capture, web links, diff-since-review; identity falls back to a one-time prompt stored in settings; `commit` empty; `.vouch/` at workspace folder root.
- **Line endings:** all hashing/counting normalizes CRLF→LF (§3, §8).
- **Corrupt JSONL line:** skip, log to output channel, warn once per session. Never crash the store.
- **Huge files (>20 k lines):** skip text-scan relocation (symbol step and exact stored-range hash check only — i.e., the single window at the last-known range); note in hover. Bounds worst-case O(N·L) scans.
- **Concurrent editors:** single-writer per window per author shard; `fs.appendFile`; watcher reconciles cross-window.

## 10. Testing

- **Unit (vitest, plain Node):** hasher (CRLF + line-count convention fixtures: trailing newline, empty file), JSONL parse/dedupe/chain resolution (supersedes forks by createdAt, chain-wide revoke, revoke-of-latest — must NOT resurrect predecessor), auto-supersede overlap logic, two-stage scan fixtures (moved / edited / deleted / duplicated first lines), coverage math (empty file exclusion, attested-only rollups, kind=file).
- **Integration (`@vscode/test-electron`):** fixture workspace; run vouch commands; assert decoration sets, tree data, hover contents; edit → dismissal; symbol rename → text-scan re-anchor; append from "another user" shard → merge/dedupe; re-attach round-trip; flat-SymbolInformation language fixture degrades to selection.
- TDD throughout implementation (superpowers flow).

## 11. V2 backlog

- Follow git renames automatically; auto re-attach.
- Opt-in text snapshots for exact diff baselines of never-committed reviews.
- Inline (GitLens-style) call-site decorations, toggleable.
- CI/enforcement: fail PR if changed lines lack live review (CLI companion reading `.vouch/`).
- GitHub handle mapping for display/links.
- Line-by-line threaded comments.
- Purge/compact history command.
- Marketplace publish pipeline (extension is local `.vsix` first).

## 12. Naming & commands

| Command                 | Title                              |
| ----------------------- | ---------------------------------- |
| `vouch.init`            | Vouch: Initialize in workspace     |
| `vouch.selection`       | Vouch: Review selected lines       |
| `vouch.function`        | Vouch: Review enclosing function   |
| `vouch.class`           | Vouch: Review enclosing class      |
| `vouch.file`            | Vouch: Review entire file          |
| `vouch.reReview`        | Vouch: Re-review (after dismissal) |
| `vouch.unvouch`         | Vouch: Revoke my review            |
| `vouch.showDiff`        | Vouch: Diff since my review        |
| `vouch.openCommitOnWeb` | Vouch: Open review commit on web   |
| `vouch.reattach`        | Vouch: Re-attach orphaned reviews  |

Tech stack: TypeScript, esbuild bundling, `@vscode/vsce` packaging. No runtime dependencies beyond Node built-ins (`crypto`, `fs`) and the VS Code API; git access via child_process (no libgit2).
