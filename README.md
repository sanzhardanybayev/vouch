# Vouch

Vouch is a VS Code extension (Cursor-compatible) for tracking **human-authored review
coverage** in a codebase where an increasing share of the code is written by AI. Writing
code has gotten cheap; a human actually reading it and vouching for it has not. Vouch lets
a reviewer mark any span of code — a selection, a function, a class, or a whole file — as
reviewed. The attestation is tied to the exact text of that span, so the moment the code
changes underneath it, the mark is automatically dismissed. Coverage is visible everywhere
you look: a gutter icon on reviewed and dismissed ranges, a hover with the full review
timeline, status at call sites, and a workspace-wide coverage sidebar. Review records are
stored as plain files inside a versioned `.vouch/` folder, so the whole team shares review
state through git, the same way you'd share test coverage — except this coverage is a human
saying "I read this."

## Install

Vouch is currently distributed as a `.vsix` file, not through the Marketplace. Build or
obtain `vouch-0.0.1.vsix`, then install it into your editor of choice.

**VS Code**, from the command line:

```bash
code --install-extension vouch-0.0.1.vsix
```

**Cursor**, from the command line (Cursor ships a `cursor` CLI that takes the same flag):

```bash
cursor --install-extension vouch-0.0.1.vsix
```

**Cursor**, from the UI: open the Extensions view, click the `⋯` (more actions) menu at the
top of the panel, choose **Install from VSIX...**, and select the file. The same flow works
in VS Code's Extensions view if you prefer clicking over the CLI.

## Quickstart

1. Open a git repository in VS Code or Cursor.
2. Run **Vouch: Initialize in workspace** from the command palette. This creates
   `.vouch/config.json` and adds a `merge=union` line for `.vouch/reviews/**` to
   `.gitattributes`.
3. Read some code. Select the lines you actually reviewed and run **Vouch: Review selected
   lines** (also reachable from the editor's right-click **Vouch** submenu). You'll be
   prompted for an optional comment.
4. Look at the gutter: a green check now sits on the first line of the range you reviewed.
5. Open the **Vouch** view in the activity bar to see workspace-wide review coverage — a
   file tree with a percentage on every file that has at least one record, and header stats
   summarizing reviewed/dismissed counts across the team.

From there, **Vouch: Review enclosing function** and **Vouch: Review enclosing class**
snap the same attestation to a symbol range (when a language server is available), and
**Vouch: Review entire file** attests the whole document.

## How the three statuses work

Every attested range is in exactly one of three states, computed at render time — nothing
is cached as "status" in storage, because a cached status would rot the instant the code
moves and would conflict across merges:

- **Reviewed** (✓, green gutter icon) — the current text of the range hashes identically to
  what was reviewed. Nothing has changed since a human looked at it.
- **Dismissed** (⚠, orange gutter icon) — a record exists for this range, but the text has
  changed since the review (even a whitespace or comment edit counts — Vouch hashes exact
  text). The hover explains it was dismissed and offers **Vouch: Re-review** and **Vouch:
  Diff since my review** to see what changed.
- **Absence** (no icon) — the third status. Code with no review record at all renders
  exactly like unreviewed code always has: nothing. Absence of a mark is itself information
  — it means no one has vouched for this code yet.

When a symbol-anchored review's code moves (e.g. the function is relocated but not edited),
Vouch follows it via the language server's symbol provider first, falling back to a
text-based scan, so the icon stays attached to the code rather than a stale line number.

## Storage model

Review records live under a `.vouch/` folder at the git repository root and are meant to be
**committed like any other source file**:

```
.vouch/
  config.json
  reviews/
    src/auth/service.ts/
      a1b2c3d4.jsonl   # one JSONL file per author (slug = 8 hex chars of sha256(email))
```

Each line in a shard file is one append-only JSON record: who reviewed, when, what commit
was HEAD at the time, the hash of the exact text reviewed, and an optional comment.
Revocations ("Vouch: Revoke my review") are appended as tombstone records rather than
deleting anything — the store is write-once, so history is never rewritten.

Records are sharded **per author**, not per file or per team. This is deliberate: two
different authors reviewing the same file write to two different files, so their reviews
never conflict, even when merged through a hosted platform's web UI (GitHub/GitLab merges
don't honor `.gitattributes` merge drivers). `Vouch: Initialize in workspace` also adds a
`.vouch/reviews/** merge=union` line to `.gitattributes` as a hint for local merges and
rebases, so that if the same author's shard genuinely conflicts across branches, git prefers
"keep both sides" over a manual conflict — append-only records merge safely under a union
strategy because nothing is ever removed, only appended.

## Team workflow

Because `.vouch/` is committed, a review becomes part of the pull request that contains it:
open a PR, and the diff includes the reviewer's attestations right alongside the code they
cover. Reviewers on other branches or forks never step on each other — per-author sharding
means a hosted merge of two PRs that both touch the same file's reviews just concatenates
two different files, no conflict markers, no manual resolution. Coverage accumulates the
same way test coverage does: incrementally, as a side effect of people doing their normal
work of reading and clicking a command, not as a separate process someone has to remember
to run.

## Limitations (v1)

- **Renames require manual re-attach.** If a reviewed file is renamed or moved on disk,
  Vouch does not follow it automatically. The file's records show up under an **Orphans**
  node in the sidebar; running **Vouch: Re-attach** lets you point them at the new path.
  Automatic rename-following is planned for a later version.
- **Dismissal is exact-text, not semantic.** Any change to the reviewed range — including
  whitespace or comment-only edits — dismisses the attestation. There's no fuzzy or
  semantic diffing to decide whether a change was "trivial."
- **Symbol-aware commands need a language server.** **Vouch: Review enclosing function**
  and **Vouch: Review enclosing class** rely on the editor's document symbol provider. In a
  language without an active language server (or one that only returns flat
  `SymbolInformation` rather than hierarchical symbols), these commands fall back to
  plain selection-based records with no symbol path, and relocation after edits uses
  text-scanning instead of symbol lookup.

## Security

Review records under `.vouch/` are data synced from every contributor to a repository —
including forks and branches you don't control — so Vouch treats every field in a record as
**untrusted input**, not just trusted metadata. Rendering surfaces are built defensively:

- Hover markdown and the review timeline webview HTML-escape every user-controlled field
  (comments, author names, status strings) before rendering it.
- Command links rendered inside hovers and the timeline are restricted to a fixed allowlist
  of known Vouch commands — a record can never smuggle in an arbitrary command to execute.
- Commit links are only ever rendered as clickable when the target commit hash passes SHA
  validation and the resulting link is `https://` — no `javascript:`, no other schemes, and
  malformed or missing commit data degrades to plain (non-linked) text instead of failing
  closed or open.

This matters in practice whenever you pull a branch or review a PR from someone else: their
`.vouch/` shards land in your workspace and get rendered before you've reviewed their code,
so the rendering path itself has to be safe against adversarial input.
