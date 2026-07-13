# Task 4 Report: Sidebar — count all files, honest coverage, Reviewers node

## Status: COMPLETE

## Commit
- **SHA**: `684cd7f`
- **Message**: `feat: sidebar counts all files for honest coverage, adds Reviewers node`

## What was done

1. **TDD Step 1** — Appended the `v1.1 honest coverage + reviewers` integration test
   to `test/vscode-int/suite/extension.test.ts` (Step 1 from the brief), with one
   necessary adaptation: `const root = api.context.roots[0]` needed a non-null
   assertion (`api.context.roots[0]!`) to satisfy the repo's
   `noUncheckedIndexedAccess` strict setting (the brief's snippet omitted it; this
   matches the existing convention elsewhere in the same test file, e.g.
   `vscode.workspace.workspaceFolders![0]!`).

2. **Step 2 (verify failure)** — Confirmed `npm run test:int` failed at the build
   step before implementation, since `src/vscode/sidebar.ts` still referenced the
   pre-Task-1 `TreeFile`/`headerStats` shape (`{path, coverage}` missing
   `reviewed`; `HeaderStats.attested` no longer exists — it's `reviewedFiles` now).
   This is exactly the intentional break described in the task.

3. **Step 3 (implement)** — Replaced `src/vscode/sidebar.ts` with the brief's full
   version. Verified against the actual current signatures of every consumed
   module before writing (`core/coverage.ts`, `core/text.ts`, `core/treemodel.ts`,
   `core/store.ts` `EngineerSummary`/`perEngineer`, `vscode/context.ts`,
   `vscode/pipeline.ts`, `vscode/gitinfo.ts`) — all matched the brief's
   expectations with no adjustments needed. Key changes from the v1 file:
   - `covCache` entries now carry a `reviewed: boolean` flag alongside
     `coverage`.
   - `refresh()` enqueues **every** tracked file from `fileList` (git
     `ls-files`, capped at `MAX_FILES = 20_000` with a `console.warn` on
     overflow), not just `store.attestedFiles()`.
   - `onPipelineUpdate` no longer gates on "is attested" before jumping a file
     to the front of the queue — any tracked file's pipeline update is
     prioritized.
   - `processJob` branches on `isAttested()`: attested files resolve records
     (live-buffer-aware via the pipeline, same as before) and set
     `reviewed: true`; unreviewed files are line-counted only via the new
     `countFileCoverage()` helper (binary/empty/unreadable → `null`,
     excluded; otherwise `{reviewedLines: 0, totalLines: N}`) and set
     `reviewed: false`.
   - `treeFiles()` reads directly off `covCache`/`fileList` (no more
     `attested` Set gate) and threads `reviewed` through into each
     `TreeFile`.
   - Header row now reads `headerStats(files, files.length, counts)` and
     renders `${workspacePct}% · ${reviewedFiles}/${totalFiles} files · ${records} reviews`
     (previously `"% of attested"` / `attested`/`totalFiles`).
   - File tree rows show a `%` only when `file.reviewed === true` and
     coverage is resolved (not `pending`/`null`); unreviewed/excluded files
     render as a plain outline dot with no percentage.
   - Added a `Reviewers` root node (shown only when `engineers().length > 0`)
     that lists engineers (via aggregated `store.perEngineer()` across all
     roots, summed by email) → each engineer's reviewed files with per-file
     review counts, with an "Open" command wired to the resolved root.
   - Preserved verbatim: the covCache gen-pruning loop in `refresh()`, the
     `onPipelineUpdate`/open-doc-via-pipeline branch and its comments for
     attested files, the error-sentinel catch block (`coverage: null`, now
     also `reviewed: false`), and the 25ms `setTimeout` queue spacing in
     `runQueue()`.

4. **Step 4 (full gate)** — All green, run twice to check for timing flakiness
   (none observed; new integration test settled consistently at ~1500ms wall
   time against its 1500ms `setTimeout`, well within the 2s total suite time):
   - `npm run typecheck` — clean, 0 errors (previously 3 errors from the
     intentional Task 1 break).
   - `npm test` — 123/123 unit tests passed (18 files), comfortably above the
     111+ floor.
   - `npm run test:int` — 7/7 integration tests passed, including the new
     `v1.1 honest coverage + reviewers` test.

5. **Step 5 (commit)** — Committed `src/vscode/sidebar.ts` and
   `test/vscode-int/suite/extension.test.ts` only, using the brief's exact
   commit message.

## Test Summary
Unit: 123/123 passed (`npm test`, 18 files, no unit tests added/changed — Task 1/3's
unit tests already cover the underlying logic). Integration: 7/7 passed
(`npm run test:int`) — 6 pre-existing + 1 new (`v1.1 honest coverage + reviewers`).
No flakiness observed across two consecutive runs; the brief's suggested "raise
settle timeout if flaky" was not needed.

## Concerns
- None blocking. One minor, intentional deviation from the brief's literal
  test snippet: added a non-null assertion (`roots[0]!`) to satisfy this
  repo's `noUncheckedIndexedAccess` compiler option — required for the test
  file to compile at all, consistent with existing patterns in the same file
  and in the brief's own sidebar.ts replacement (`this.ctx.roots[0]!`).
- The fixture repo (`test/vscode-int/fixture`) has only one tracked file
  (`src/calc.ts`), so the new integration test's commented-out
  `reviewedFiles < totalFiles` assertion was correctly left as a comment only
  (per the brief's own note that the actual code block contains no such
  assertion) — asserting it for real would be fixture-dependent and brittle
  with a 1-file fixture.
- Note: this report file previously contained content for an unrelated,
  differently-numbered "Task 4" (per-author shard paths/writer/vouch init) —
  that content has been replaced with this task's report since the report
  contract designates this path for the current task.

## Fix Report

Three Important review findings against the v1.1 `src/vscode/sidebar.ts` were
fixed (branch `feat/vouch-v1.1`).

### Finding 1 — "everything pending" latency on every review action

Root cause: `refresh()` bumped a global `gen` and requeued **every** tracked
file on every attest/dismiss/revoke; `treeFiles()` rendered any cache entry
whose `gen` didn't match current as `'pending'`. So one attested-file change
made the whole tree (header + every folder + every file) show `'…'` until the
full 25ms/file queue drained — ~7s for a 288-file repo.

Fix, all in `src/vscode/sidebar.ts`:
- `CacheEntry` dropped `gen`; it's now `{ mtimeMs, coverage, reviewed }`.
  Presence of an entry is what makes a file render as counted;
  `gen`-vs-current comparison is gone entirely (the `private gen = 0` field on
  `CoverageTree` was removed — nothing else in the codebase referenced it).
- `treeFiles()` now renders `cached.coverage`/`cached.reviewed` whenever an
  entry **exists**; only emits `'pending'` when there is no entry at all.
- `refresh()` no longer mass-invalidates. It (a) prunes `covCache` entries
  whose absolute path fell out of the current `fileList` (deleted file / root
  that no longer exists — keeps the cache from growing unboundedly), then (b)
  requeues only files that are attested (record set may have changed even if
  text didn't — always recompute) or have no cache entry yet (first count).
  Already-counted unreviewed files are left untouched.
- `processJob()`'s attested branch (the disk-read path; the open-doc→
  `pipeline.statusFor` path was already always-fresh and is unchanged) now
  **always** recomputes — no mtime-skip — since the attested record set can
  change without the file's own mtime changing. The unreviewed branch keeps
  its `mtimeMs` guard (a line count doesn't depend on the record set). The
  error branch's sentinel entry dropped `gen` too.
- `onPipelineUpdate()` is unchanged (unshift + runQueue); it now naturally
  recomputes-if-attested or counts-if-uncounted via the same `processJob`.

Result: after the first full pass populates `covCache`, a single
attest/dismiss/revoke requeues only the small attested set (+ any brand-new
uncounted file), so the tree renders instantly from cache instead of the
whole workspace going pending. Verified by re-reasoning through the 288-file
scenario: `refresh()`'s filter now enqueues O(attested files), not O(all
files).

### Finding 2 — multi-root `engineerFile` opens the wrong root's file

Root cause: `engineers()` merged `EngineerSummary.files` across roots with
`ex.files.push(...e.files)`, discarding which root each file came from;
`getChildren` then guessed via `roots.find(r => isAttested(r, sourcePath)) ??
roots[0]`, which silently picks the wrong root when two roots share a
same-named path.

Fix: added `src/core/engineers.ts` exporting a pure, generic
`aggregateEngineers<R>(roots: R[], summariesOf: (root: R) =>
EngineerSummary[])` helper that tags every file entry with the root it came
from while iterating (`{ root: R; sourcePath: string; count: number }`),
aggregating engineer identity by email (name/reviewCount summed) while
keeping per-file root tags distinct. `sidebar.ts`'s `engineers()` now just
calls `aggregateEngineers(this.ctx.roots, root => root.store.perEngineer())`,
and `getChildren`'s `'engineer'` branch uses `f.root` directly — the
`roots.find(...) ?? roots[0]` heuristic is gone. A same-named file in two
roots now yields two distinct `engineerFile` rows, each opening its own
root's copy.

Added `test/core/engineers.test.ts` (4 tests, vscode-free, plain-object
roots) covering: single-root passthrough, the exact multi-root bug scenario
(same `sourcePath` in two roots → two entries distinguishable by root
identity, reviewCount summed), cross-root email aggregation + sort order, and
the empty-roots case.

### Finding 3 — `fileList` loaded once at activation, never refreshed

Root cause: `loadFileLists()` ran once in the constructor; a deleted file
stayed in `fileList` forever (permanent `'pending'` ghost after Finding 1's
fix, since it would never get pruned or re-counted), and a new file was never
discovered.

Fix: constructor now also creates `vscode.workspace.createFileSystemWatcher('**/*')`
and wires `onDidCreate`/`onDidDelete` (deliberately **not** `onDidChange` —
content edits don't change file-set membership) to a 300ms-debounced
`loadFileLists().then(() => this.refresh())`, coalescing bursts (e.g. a git
checkout touching many files) into one reload. The watcher and its debounce
timer's disposer are pushed onto the `subscriptions` array passed into the
constructor, matching the existing disposal pattern used elsewhere in the
file (and in `extension.ts` for the `.vouch/reviews` watcher). Combined with
Finding 1's mtime/presence-based cache, a deleted file is now pruned from
`covCache` in `refresh()` and dropped from `fileList` by the next
`loadFileLists()` — no ghost; a new file enters `fileList` and gets counted
on the next pass.

### Test results

- `npm run typecheck` — clean, 0 errors.
- `npm test` — **127/127** passed (19 files: the pre-existing 123 plus 4 new
  in `test/core/engineers.test.ts`), run twice, no flakiness.
- `npm run test:int` — **7/7** passed, run twice, no flakiness (the existing
  `v1.1 honest coverage + reviewers` test still asserts `perEngineer`
  structure and at least one engineer present via the fixture author,
  unaffected by the aggregation refactor since it's single-root).

### Commit

`fix: sidebar cache validity by mtime not gen (no mass-pending), multi-root engineerFile root, fileList watcher`
— touches `src/vscode/sidebar.ts`, adds `src/core/engineers.ts` and
`test/core/engineers.test.ts`.
