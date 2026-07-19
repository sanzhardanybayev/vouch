# Changelog

All notable changes to the Vouch extension are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Location-bound review validity** ([#2]) - a review now attests to its text
  *in its context*, not just the characters. Records capture the enclosing
  function/class and neighborhood context hashes; identical text moved to a
  different function is dismissed, and duplicated matches surface as a new
  **ambiguous** status (amber `?` in the gutter, CodeLens, hover, timeline)
  with a one-click **Resolve** flow instead of a silent nearest-range guess.
  Commit SHA remains provenance only: rebases and restacks never touch
  review validity. An unavailable language server can only degrade a mark
  toward ambiguous, never produce a wrong green.
- **`.vouchignore`** - gitignore-style patterns at the repo root exclude
  lockfiles, vendored, and generated paths from the coverage tree,
  percentages, header counts, reviewer stats, and orphans.
- **`Vouch: Refresh reviews and coverage`** command and a
  **`vouch.coverage.enabled`** setting; the tracked-file scan now runs only
  in repositories that contain `.vouch/`, with an init hint shown elsewhere.
- Corrupt `.vouch` lines and the 20k-tracked-file cap are surfaced (one-shot
  warning + persistent header tooltip) instead of silently skewing coverage.
- **Consolidating supersede** - reviewing a scope that fully encloses your own
  earlier reviews supersedes them; the absorbed reviews stay navigable as chain
  history in the timeline, with a "supersedes N earlier reviews" note on hover.
  Partial overlap never supersedes: those reviews coexist as peers. When an
  absorbed review carries a comment or was dismissed, Vouch asks before writing
  and can copy the old comments into the new review as an editable prefill, or
  show a diff of what changed under a dismissed one. Rationale in
  [ADR 0001](docs/adr/0001-supersede-on-enclosure-only.md).

### Fixed

- **Reviews attest to the snapshot the reviewer read.** If the buffer changes
  while the comment or supersede dialog is open, the record is rebased to the
  unchanged content or the attest aborts with a warning - it can no longer
  hash post-dialog text at pre-dialog line numbers.
- **Revocation and supersede are author-bound.** A tombstone or supersede
  edge from one identity can no longer erase or capture another identity's
  reviews; legacy cross-author re-attach tombstones stay honored only when
  the matching moved copy (same author, same hash) exists. Re-attach now
  moves only the invoking reviewer's records and explains ownership
  otherwise.
- **Replaced reviews stay replaced.** Chain resolution follows explicit
  supersede topology instead of trusting timestamps, so clock skew between
  machines cannot resurrect an old review; record/tombstone id collisions
  resolve order-independently and can never revive a revoked chain.
- **One malformed `.vouch` line no longer breaks the sidebar** (or attest,
  or the timeline): every field consumed is validated on load, with unknown
  fields, kinds, and tombstone reasons from future versions tolerated.
- The timeline panel now resolves against the live buffer (matching the
  gutter) and re-renders on edits and store changes; CodeLens group actions
  target the right record instead of an arbitrary group representative.
- Coverage percentages are honest at the edges (100% only when fully
  reviewed), reviewer identity survives email case changes, teammate reviews
  appear after `git pull` even when the repo root sits above the workspace
  folder, and workspace folders added mid-session are recognized.

[#2]: https://github.com/sanzhardanybayev/vouch/issues/2

## [0.0.1] — 2026-07-14

Initial release.

### Added

- **Review attestations** anchored to the exact text of a selection, function,
  class, or whole file. A review is dismissed automatically when the text
  changes, and follows the code when it moves without being edited.
- **Three render-time statuses** — reviewed (✓), dismissed (⚠), and unreviewed
  (no mark) — shown as gutter icons.
- **Honest coverage** — reviewed lines over every git-tracked file's lines,
  rolled up per folder and workspace-wide in the **Vouch** sidebar.
- **CodeLens** above reviewed code showing the reviewer and time, with
  Timeline / Re-review / Diff actions. Toggle with `vouch.codeLens.enabled`.
- **Reviewers** section in the sidebar — per-engineer review counts and files.
- **Hover timeline**, **diff since review**, **re-review**, and **revoke**.
- **Git-native storage** under `.vouch/` — append-only, per-author JSONL
  shards that merge without conflicts across hosted platforms.
- **Hardened rendering** of untrusted review records: HTML escaping, command
  allowlists, and `https`-only, SHA-validated commit links.

[0.0.1]: https://github.com/sanzhardanybayev/vouch/releases/tag/v0.0.1
