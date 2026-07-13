<div align="center">

# ✓ Vouch

### Human review coverage for the age of AI-generated code.

Writing code got cheap. A human actually reading it and vouching for it did not.
**Vouch** tracks who reviewed what — anchored to the exact text, shared through git, honest by default.

[![License: MIT](https://img.shields.io/github/license/sanzhardanybayev/vouch?color=blue)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Cursor](https://img.shields.io/badge/Cursor-compatible-000000?logo=cursor&logoColor=white)](https://cursor.com/)
[![Tests](https://img.shields.io/badge/tests-144%20passing-brightgreen)](#development)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

</div>

---

Vouch is a VS Code extension (Cursor-compatible) that treats **human review as coverage you can measure**. Mark any span of code — a selection, a function, a class, or a whole file — as reviewed. The mark is tied to the exact text of that span, so the instant the code changes underneath it, the mark is automatically dismissed. Coverage shows up everywhere you already look — a gutter icon, an inline CodeLens, a hover timeline, and a workspace-wide sidebar — and lives as plain files in a versioned `.vouch/` folder, so your whole team shares review state through git. Like test coverage, but the coverage is a person saying *"I read this."*

<!-- Drop a demo GIF here once recorded: ![Vouch demo](docs/demo.gif) -->

```
 src/auth/service.ts
   ✓ 18 │  async function login(email, password) {       ← reviewed, green gutter check
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
| ✓ **Reviewed / dismissed / unreviewed** | Three render-time statuses, tied to an exact-text hash — never a stale cached flag |
| 📊 **Honest coverage** | Reviewed lines ÷ all tracked lines, rolled up per folder and workspace-wide |
| 🔎 **Gutter + CodeLens + hover** | See status at the line, an inline `✓ Reviewed by …` lens, and a full per-reviewer timeline on hover |
| 🧭 **Coverage sidebar** | A file tree with per-file/per-folder percentages and a **Reviewers** section per engineer |
| 🕰️ **Timeline & diff** | Jump back to any past review; diff the code against what was reviewed |
| 🔁 **Re-review & revoke** | Re-attest changed code or revoke a review — as append-only tombstones |
| 🧬 **Git-native storage** | Per-author JSONL shards under `.vouch/`, conflict-free across hosted merges |
| 🛡️ **Hardened rendering** | HTML-escaping, command allowlists, and `https`-only, SHA-validated commit links |

## Install

Vouch is distributed as a `.vsix` (not yet on the Marketplace). Build it yourself (see [Development](#development)) or grab `vouch-0.0.1.vsix`, then:

```bash
# VS Code
code --install-extension vouch-0.0.1.vsix

# Cursor (ships a `cursor` CLI that takes the same flag)
cursor --install-extension vouch-0.0.1.vsix
```

Prefer clicking? In either editor's **Extensions** view, open the `⋯` menu → **Install from VSIX…** and pick the file.

## Quickstart

1. Open a git repository.
2. Run **`Vouch: Initialize in workspace`** from the command palette. This creates `.vouch/config.json` and adds a `merge=union` hint for `.vouch/reviews/**` to `.gitattributes`.
3. Read some code. Select the lines you reviewed and run **`Vouch: Review selected lines`** (also on the editor's right-click **Vouch** submenu). Add an optional comment.
4. A green ✓ appears in the gutter, and a `✓ Reviewed by you, just now` CodeLens sits above the range.
5. Open the **Vouch** view in the activity bar for workspace-wide coverage — an honest per-file/per-folder tree and a **Reviewers** section.

> **Tip** — `Vouch: Review enclosing function` / `…enclosing class` snap the attestation to a symbol (when a language server is available); `Vouch: Review entire file` attests the whole document.

## Concepts

### The three statuses

Every attested range is in exactly one state, computed **at render time** — status is never stored, because a cached status rots the instant the code moves and conflicts across merges.

| Status | Gutter | Meaning |
|---|:---:|---|
| **Reviewed** | ✓ green | Current text hashes identically to what was reviewed. Nothing has changed since a human read it. |
| **Dismissed** | ⚠ orange | A record exists, but the text changed since review — even a whitespace or comment edit (Vouch hashes exact text). Re-review or diff to see what changed. |
| **Unreviewed** | *(none)* | No record at all. Absence is itself the signal: no one has vouched for this yet. |

When a symbol-anchored review's code moves but isn't edited, Vouch follows it via the language server's symbol provider first, then a text scan — so the mark stays attached to the code, not a stale line number.

### Honest coverage

A folder's percentage is **reviewed lines ÷ lines across every git-tracked file** in it — an untouched file still contributes its full line count to the denominator. A hundred-file folder with one small reviewed selection shows a low, honest number, not 100%. Binary and empty files are excluded from the ratio entirely; unreviewed files stay visually dim in the tree while still counting against their folder's total.

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

Records are sharded **per author** on purpose: two people reviewing the same file write to two different files, so their reviews never collide — even through a hosted web-UI merge, which ignores `.gitattributes` merge drivers. Init also writes a `.vouch/reviews/** merge=union` hint for local merges/rebases, so same-author shards that genuinely diverge resolve to "keep both" instead of a manual conflict (safe, because nothing is ever removed).

## Surfaces

- **Gutter** — a ✓ / ⚠ on the first line of each reviewed / dismissed range.
- **CodeLens** — an inline `✓ Reviewed by <name>, <time>` above reviewed code, with **Re-review** and **Diff** actions; click the reviewer text to open the **Timeline**. Flips to `⚠ Dismissed (changed since review) — re-review` when the text changes. Toggle with [`vouch.codeLens.enabled`](#settings).
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
| `Vouch: Re-attach orphaned reviews` | Point a renamed file's reviews at its new path |

## Settings

| Setting | Default | Description |
|---|:---:|---|
| `vouch.codeLens.enabled` | `true` | Show the CodeLens above reviewed code with reviewer, time, and Timeline / Re-review / Diff links. |

## Team workflow

Because `.vouch/` is committed, a review is part of the PR that contains it — open a pull request and the diff includes the reviewer's attestations right beside the code they cover. Per-author sharding means a hosted merge of two PRs that both touch the same file's reviews just concatenates two files: no conflict markers, no manual resolution. Coverage accumulates the way test coverage does — incrementally, as a side effect of people reading code and running a command, not a separate process anyone has to remember.

## Security

Records under `.vouch/` are synced from every contributor — including forks and branches you don't control — so Vouch treats **every field as untrusted input**. Their `.vouch/` shards land in your workspace and render *before* you've reviewed their code, so the rendering path itself is built to be safe against adversarial data:

- Hover markdown and the timeline webview **HTML-escape** every user-controlled field (comments, author names, status strings) before rendering.
- Command links in hovers and the timeline are restricted to a **fixed allowlist** of Vouch commands — a record can never smuggle in an arbitrary command.
- Commit links render as clickable only when the hash passes **SHA validation** and the URL is **`https://`** — no `javascript:` or other schemes; malformed or missing commit data degrades to plain text.
- Git is invoked via `execFile` with argument arrays and `--end-of-options` guards — never a shell — and shard paths reject `..` traversal.

## Development

Vouch is a pure-Node core (`src/core/**`, no `vscode` imports, unit-tested with vitest) wrapped by thin VS Code adapters (`src/vscode/**`), with an end-to-end suite that runs against a real downloaded VS Code build.

```bash
npm install

npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest — core unit tests
npm run test:int     # @vscode/test-electron — integration suite (downloads VS Code on first run)
npm run package      # build + produce vouch-0.0.1.vsix

npm run watch        # rebuild on change while developing
```

Press **F5** in VS Code to launch an Extension Development Host with Vouch loaded. Requires Node 18+ and git on `PATH`. The test suite is **144 tests** (136 unit + 8 integration) and must stay green.

## Roadmap / Limitations

- **Renames need manual re-attach.** A renamed or moved file's records appear under an **Orphans** node; `Vouch: Re-attach` points them at the new path. *Automatic rename-following is planned.*
- **Dismissal is exact-text, not semantic.** Any edit to a reviewed range — whitespace or comment-only included — dismisses it. There's no fuzzy/semantic "was this trivial?" diffing.
- **Symbol commands need a language server.** Without an active document-symbol provider (or one that returns only flat symbols), the function/class commands fall back to selection records and text-scan relocation.
- **Planned:** lines-reviewed-per-engineer, a `.vouchignore` to shape the coverage denominator, and Marketplace distribution.

## Contributing

Issues and PRs are welcome. Please keep the core (`src/core`) free of `vscode` imports, add or update tests for any behavior change, and run `npm run typecheck && npm test && npm run test:int` before opening a PR. See the design docs under `docs/superpowers/` for the architecture and rationale.

## License

[MIT](LICENSE) © Sanzhar Danybayev
