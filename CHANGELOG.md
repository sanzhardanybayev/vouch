# Changelog

All notable changes to the Vouch extension are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Consolidating supersede** - reviewing a scope that fully encloses your own
  earlier reviews supersedes them; the absorbed reviews stay navigable as chain
  history in the timeline, with a "supersedes N earlier reviews" note on hover.
  Partial overlap never supersedes: those reviews coexist as peers. When an
  absorbed review carries a comment or was dismissed, Vouch asks before writing
  and can copy the old comments into the new review as an editable prefill, or
  show a diff of what changed under a dismissed one. Rationale in
  [ADR 0001](docs/adr/0001-supersede-on-enclosure-only.md).

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
