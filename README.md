<div align="center">

<img src="media/icon.png" width="120" alt="Vouch logo" />

# Vouch

### Human review coverage for the age of AI-generated code.

Writing code got cheap. A human actually reading it and vouching for it did not.
**Vouch** tracks who reviewed what — anchored to the exact text, shared through git, honest by default.

[![Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Vouch-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sanzhardanybayev.vouch-review-coverage)
[![License: MIT](https://img.shields.io/github/license/sanzhardanybayev/vouch?color=blue)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Cursor](https://img.shields.io/badge/Cursor-compatible-000000?logo=cursor&logoColor=white)](https://cursor.com/)
[![Tests](https://img.shields.io/badge/tests-265%20passing-brightgreen)](#development)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

</div>

---

Vouch is a VS Code extension (Cursor-compatible) that treats **human review as coverage you can measure**. Mark any span of code — a selection, a function, a class, or a whole file — as reviewed. The mark is tied to the exact text of that span, so the instant the code changes underneath it, the mark is automatically dismissed. Coverage shows up everywhere you already look — a gutter icon, an inline CodeLens, a hover timeline, and a workspace-wide sidebar — and lives as plain files in a versioned `.vouch/` folder, so your whole team shares review state through git. Like test coverage, but the coverage is a person saying *"I read this."*

<!-- Drop a demo GIF here once recorded: ![Vouch demo](docs/demo.gif) -->

```
 src/auth/service.ts
   ✓ 18 │  async function login(email, password) {       ← reviewed, teal gutter check
     19 │    const user = await this.users.find(email)
   ⚠ 42 │  async function refresh(token) {               ← dismissed: code changed since review
```
```
 VOUCH · REVIEW COVERAGE
 ⛨ Coverage        23% · 14/288 files · 31 reviews
 ▸ Reviewers
     Sanzhar          22 reviews · 9 files
     Alia              9 reviews · 5 files
 ▸ src               41%
     auth  ●100%   parser  ◐67%   cli  ◑12%
```

## Table of contents

[Why Vouch](#why-vouch) · [Features](#features) · [Install](#install) · [Quickstart](#quickstart) · [Concepts](#concepts) · [Surfaces](#surfaces) · [Commands](#commands) · [Settings](#settings) · [Team workflow](#team-workflow) · [Security](#security) · [Development](#development) · [Roadmap](#roadmap--limitations) · [Contributing](#contributing) · [License](#license)

## Why Vouch

AI writes a large and growing share of the code in most repositories. Review is now the bottleneck — and it's invisible. There's no signal for *which* AI-written code a human has actually read, no way to tell a reviewed function from an unreviewed one, and nothing that notices when reviewed code silently changes out from under its review. Vouch makes that signal a first-class, versioned artifact:

- **Anchored to the code, not to a line number.** A review is tied to the exact text it covered. Edit the text and the review is dismissed; move the code without editing it and the review follows.
- **Honest coverage.** A folder's percentage is reviewed lines over *every* tracked file's lines — one small review in a big folder reads low, not 100%.
- **Shared through git, not a SaaS.** Records are plain append-only files in `.vouch/`. They ride along in the same PR as the code they cover.
- **Safe on untrusted input.** Records sync from every branch and fork; every rendering path treats them as adversarial.

## Features

| | |
|---|---|
| ✓ **Reviewed / dismissed / ambiguous / unreviewed** | Render-time statuses tied to exact text AND location - never a stale cached flag, never a guess |
| 📍 **Location-bound reviews** | A review attests to code *in its context*: identical text moved to another function, or duplicated, never silently keeps a green mark |
| 📊 **Honest coverage** | Reviewed lines ÷ all tracked lines, rolled up per folder and workspace-wide; `.vouchignore` shapes the denominator |
| 🔎 **Gutter + CodeLens + hover** | See status at the line, an inline `✓ Reviewed by …` lens, and a full per-reviewer timeline on hover |
| 🧭 **Coverage sidebar** | A file tree with per-file/per-folder percentages and a **Reviewers** section per engineer |
| 🕰️ **Timeline & diff** | Jump back to any past review; diff the code against what was reviewed |
| 🔁 **Re-review & revoke** | Re-attest changed code or revoke a review — as append-only tombstones |
| 🧬 **Git-native storage** | Per-author JSONL shards under `.vouch/`, conflict-free across hosted merges of different reviewers' work |
| 🛡️ **Hardened records** | Untrusted-input rendering, author-bound revocation and supersede, HTML-escaping, command allowlists, `https`-only SHA-validated commit links |

## Install

**VS Code — from the Marketplace.** Search **"Vouch - Review Coverage"** in the Extensions view, or:

```bash
code --install-extension sanzhardanybayev.vouch-review-coverage
```

Or open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=sanzhardanybayev.vouch-review-coverage).

**Cursor / VSCodium.** These install from [Open VSX](https://open-vsx.org), not the VS Code Marketplace. Until the Open VSX release lands, install from the packaged file — grab `vouch-review-coverage-0.0.1.vsix` (from [Releases](https://github.com/sanzhardanybayev/vouch/releases) or `npm run package`) and run:

```bash
cursor --install-extension vouch-review-coverage-0.0.1.vsix
```

or use **Extensions → ⋯ → Install from VSIX…**.

## Quickstart

1. Open a git repository.
2. Run **`Vouch: Initialize in workspace`** from the command palette. This creates `.vouch/config.json` and adds a `merge=union` hint for `.vouch/reviews/**` to `.gitattributes`.
3. Read some code. Select the lines you reviewed and run **`Vouch: Review selected lines`** (also on the editor's right-click **Vouch** submenu). Add an optional comment.
4. A teal ✓ appears in the gutter, and a `✓ Reviewed by you, just now` CodeLens sits above the range.
5. Open the **Vouch** view in the activity bar for workspace-wide coverage — an honest per-file/per-folder tree and a **Reviewers** section.

> **Tip** — `Vouch: Review enclosing function` / `…enclosing class` snap the attestation to a symbol (when a language server is available); `Vouch: Review entire file` attests the whole document.

## Concepts

### The four statuses

Every attested range is in exactly one state, computed **at render time** — status is never stored, because a cached status rots the instant the code moves and conflicts across merges.

| Status | Gutter | Meaning |
|---|:---:|---|
| **Reviewed** | ✓ teal | Current text hashes identically to what was reviewed, in the location that was reviewed. Nothing has changed since a human read it. |
| **Dismissed** | ⚠ orange | A record exists, but the text changed since review — even a whitespace or comment edit (Vouch hashes exact text) — or it moved out of its reviewed context. Re-review or diff to see what changed. |
| **Ambiguous** | ? amber | The reviewed text now matches more than one place (or its recorded location cannot be verified) and no signal can prove which copy was reviewed. Vouch never guesses: click **Resolve** to pin the right one. |
| **Unreviewed** | *(none)* | No record at all. Absence is itself the signal: no one has vouched for this yet. |

### Location binding

A review attests to more than characters - it attests to those characters *in a place*. Every review therefore carries two identities:

- **Content identity** - a hash of the exact selected lines. Any edit dismisses the review.
- **Location identity** - the enclosing function/class (from the language server) plus hashes of the two lines directly above and below. Line numbers are only a display hint; inserting code above a review never touches it.

Resolution follows the code through rebases and line shifts, but degrades honestly when certainty runs out: identical text moved into a *different* function is dismissed, a renamed enclosing symbol or duplicated match turns ambiguous (one click to resolve), and an unavailable language server can only ever downgrade a mark toward ambiguous - never upgrade it toward a wrong green. The commit SHA is provenance, not validity: a Graphite restack or rebase that rewrites every commit leaves reviews untouched.

### Superseding your own reviews

Reviewing a scope that **fully encloses** your earlier reviews (e.g. a whole function or file over reviews of pieces inside it) supersedes them: the new review becomes current and the absorbed ones stay navigable as chain history in the timeline, with a `supersedes N earlier reviews` note on hover. Partial overlap never supersedes - those reviews coexist as peers. If any absorbed review carries a comment or was dismissed, Vouch asks before writing: you can copy the old comments into the new review as an editable prefill, or view a diff of what changed under a dismissed one. Rationale lives in [ADR 0001](docs/adr/0001-supersede-on-enclosure-only.md); the shared vocabulary is in [CONTEXT.md](CONTEXT.md).

### Honest coverage

A folder's percentage is **reviewed lines ÷ lines across every git-tracked file** in it — an untouched file still contributes its full line count to the denominator. A hundred-file folder with one small reviewed selection shows a low, honest number, not 100%. Binary and empty files are excluded from the ratio entirely; unreviewed files stay visually dim in the tree while still counting against their folder's total. The number is honest at the edges too: 100% appears only when every line is reviewed, never from rounding.

Committed lockfiles, vendored code, or generated files can dominate that denominator. Add a **`.vouchignore`** at the repo root (gitignore-style patterns: `*`, `**`, `?`, `/` anchors, `!` negation) to exclude paths from the coverage universe - the tree, the percentages, the header counts, and reviewer stats all honor it. Editor surfaces (gutter, hover, CodeLens) still work in ignored files; they just do not count toward coverage.

### Storage model

Records live under a `.vouch/` folder at the repo root and are meant to be **committed like source**:

```
.vouch/
  config.json
  reviews/
    src/auth/service.ts/
      a1b2c3d4.jsonl   # one JSONL file per author — slug = 8 hex of sha256(email)
```

Each line is one **append-only** JSON record: who reviewed, when, the commit that was HEAD, the hash of the exact reviewed text, and an optional comment. Revoking a review appends a *tombstone* rather than deleting anything — the store is write-once, so history is never rewritten.

Records are sharded **per author** on purpose: two people reviewing the same file write to two different files, so their reviews never collide — even through a hosted web-UI merge, which ignores `.gitattributes` merge drivers. Init also writes a `.vouch/reviews/** merge=union` hint so LOCAL merges/rebases of same-author shards resolve to "keep both" instead of a manual conflict (safe, because nothing is ever removed).

One honest caveat: if the SAME person reviews the SAME file on two branches, those branches touch one shard file, and a hosted web merge (which ignores merge drivers) can show a conflict in it. Resolving is safe and mechanical - keep both sides' lines (that is exactly what `merge=union` does locally). Vouch validates every line on load, so a botched resolution degrades to a counted, surfaced "unreadable line", never to silent corruption.

## Surfaces

- **Gutter** — a ✓ / ⚠ / ? on the first line of each reviewed / dismissed / ambiguous range.
- **CodeLens** — an inline `✓ Reviewed by <name>, <time>` above reviewed code, with **Re-review** and **Diff** actions; click the reviewer text to open the **Timeline**. Flips to `⚠ Dismissed (changed since review) — re-review` when the text changes, and to `? Ambiguous (matches multiple locations) - resolve` when it needs a human pick. Toggle with [`vouch.codeLens.enabled`](#settings).
- **Hover** — the full per-reviewer timeline for a range, with commit links and quick actions.
- **Sidebar** — the **Vouch** activity-bar view: an honest coverage tree plus a **Reviewers** section listing each engineer (`12 reviews · 5 files`), expandable to the files they reviewed.
- **Timeline & diff** — a webview of every review on a file over time, and a diff of current code against the exact text that was reviewed.

## Commands

All commands are available from the command palette; the marking and review commands are also on the editor's right-click **Vouch** submenu.

| Command | Does |
|---|---|
| `Vouch: Initialize in workspace` | Create `.vouch/` and the `.gitattributes` hint |
| `Vouch: Review selected lines` | Attest the current selection |
| `Vouch: Review enclosing function` | Attest the function around the cursor (needs a language server) |
| `Vouch: Review enclosing class` | Attest the enclosing class |
| `Vouch: Review entire file` | Attest the whole document |
| `Vouch: Re-review (after dismissal)` | Re-attest a range whose code changed |
| `Vouch: Revoke my review` | Append a tombstone revoking your review |
| `Vouch: Diff since my review` | Diff current code against the reviewed text |
| `Vouch: Open review commit on web` | Open the review's commit on the git host |
| `Vouch: Open review timeline` | Open the per-reviewer timeline webview |
| `Vouch: Re-attach orphaned reviews` | Point a renamed file's reviews at its new path (moves your own records; each reviewer re-attaches theirs) |
| `Vouch: Refresh reviews and coverage` | Reload `.vouch/` records and rescan tracked files (manual fallback if a watcher misses an external change) |

An ambiguous review's **Resolve** action lives on its CodeLens, hover, and timeline entry: it previews each candidate location and, on pick, writes a replacement record pinned there. Only the review's author can resolve it - anyone else re-reviews the code themselves.

## Settings

| Setting | Default | Description |
|---|:---:|---|
| `vouch.codeLens.enabled` | `true` | Show the CodeLens above reviewed code with reviewer, time, and Timeline / Re-review / Diff links. |
| `vouch.coverage.enabled` | `true` | Scan tracked files for the sidebar coverage tree. When off, reviewers and orphans still show; gutter/hover/CodeLens are unaffected. The scan only ever runs in repositories that contain `.vouch/`. |

## Team workflow

Because `.vouch/` is committed, a review is part of the PR that contains it — open a pull request and the diff includes the reviewer's attestations right beside the code they cover. Per-author sharding means a hosted merge of two PRs by DIFFERENT reviewers just concatenates two files: no conflict markers, no manual resolution. (The same reviewer touching the same file's reviews on two branches can still conflict in their own shard - see [Storage model](#storage-model) for why resolving that is safe and mechanical.) Coverage accumulates the way test coverage does — incrementally, as a side effect of people reading code and running a command, not a separate process anyone has to remember.

## Security

Records under `.vouch/` are synced from every contributor — including forks and branches you don't control — so Vouch treats **every field as untrusted input**. Their `.vouch/` shards land in your workspace and render *before* you've reviewed their code, so the rendering path itself is built to be safe against adversarial data:

- Hover markdown and the timeline webview **HTML-escape** every user-controlled field (comments, author names, status strings) before rendering.
- Command links in hovers and the timeline are restricted to a **fixed allowlist** of Vouch commands — a record can never smuggle in an arbitrary command.
- Commit links render as clickable only when the hash passes **SHA validation** and the URL is **`https://`** — no `javascript:` or other schemes; malformed or missing commit data degrades to plain text.
- Git is invoked via `execFile` with argument arrays and `--end-of-options` guards — never a shell — and shard paths reject `..` traversal.
- **Revocation and supersede are author-bound.** A tombstone or supersede edge written by one identity can never erase or capture another identity's reviews, no matter what a branch or fork ships in its shard. (Legacy re-attach tombstones from v0.0.x, which moved teammates' records, stay honored only when the matching moved copy - same author, same content hash - actually exists.)
- **Attestations themselves are unauthenticated git data.** Vouch renders who a record *claims* reviewed the code; it does not cryptographically prove authorship, just as a git commit's author field proves nothing without signing. Trust the reviews in `.vouch/` exactly as far as you trust the branch's committers - the enforcement boundary is your merge process.
- **Every record field is validated on load.** Malformed lines (merge damage, hand edits, crafted input) are skipped, counted, and surfaced in the sidebar - one bad line can neither crash a surface nor silently vanish.

## Development

Vouch is a pure-Node core (`src/core/**`, no `vscode` imports, unit-tested with vitest) wrapped by thin VS Code adapters (`src/vscode/**`), with an end-to-end suite that runs against a real downloaded VS Code build.

```bash
npm install

npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest — core unit tests
npm run test:int     # @vscode/test-electron — integration suite (downloads VS Code on first run)
npm run package      # build + produce vouch-review-coverage-0.0.1.vsix

npm run watch        # rebuild on change while developing
```

Press **F5** in VS Code to launch an Extension Development Host with Vouch loaded. Requires Node 18+ and git on `PATH`. The test suite is **265 tests** (257 unit + 8 integration) and must stay green.

## Roadmap / Limitations

- **Renames need manual re-attach.** A renamed or moved file's records appear under an **Orphans** node; `Vouch: Re-attach` points your records at the new path (each reviewer re-attaches their own). *Automatic rename-following is planned.*
- **Dismissal is exact-text, not semantic.** Any edit to a reviewed range — whitespace or comment-only included — dismisses it. There's no fuzzy/semantic "was this trivial?" diffing. Likewise, a change elsewhere in the same function (a renamed variable, a removed guard) can alter what your reviewed lines *mean* without touching them - span-based review attests to text in a location, not whole-program semantics.
- **Location binding is symbol-level.** Moving identical text between two branches of the SAME function (loop body vs if-arm) is distinguished only by the neighboring-lines context, not by AST structure - VS Code's symbol provider does not expose loops or conditionals.
- **Symbol commands need a language server.** Without an active document-symbol provider (or one that returns only flat symbols), the function/class commands fall back to selection records, and location verification degrades conservatively (never toward a wrong green). Selections reviewed before the language server finishes warming up may be recorded without a location anchor.
- **Planned:** lines-reviewed-per-engineer and automatic rename-following.

## Contributing

Issues and PRs are welcome. Please keep the core (`src/core`) free of `vscode` imports, add or update tests for any behavior change, and run `npm run typecheck && npm test && npm run test:int` before opening a PR. See the design docs under `docs/superpowers/` for the architecture and rationale.

## License

[MIT](LICENSE) © Sanzhar Danybayev
