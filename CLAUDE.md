# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VS Code extension that tracks human review coverage: engineers "vouch" for spans of code; reviews are anchored, append-only records stored in `.vouch/` and travel through git.

## Commands

- Build: `npm run build` (esbuild). Watch: `npm run watch`
- Typecheck: `npm run typecheck` (tsc strict with `noUncheckedIndexedAccess` - indexed access is possibly-undefined, guard it)
- Unit tests: `npm test` (vitest, `test/core/**` only). Single file: `npx vitest run test/core/anchor.test.ts`. By name: `npx vitest run -t "<name>"`
- Integration tests: `npm run test:int` (mocha + @vscode/test-electron; downloads a real VS Code build on first run, slow; not run in CI). Prefer `npm test` during iteration.
- Lint: `npm run lint`. Format: `npm run format`
- Package: `npm run package` (vsce)

## Architecture rule

`src/core/**` is pure Node and must never import `vscode` (also enforced by ESLint). All VS Code API usage lives in `src/vscode/**` as thin adapters. New core logic gets vitest unit tests in `test/core/`.

## Domain vocabulary and invariants

`CONTEXT.md` is the canonical glossary (review, chain, supersede, current, revoke, tombstone; reviewed/dismissed/ambiguous/unreviewed statuses). Use its terms exactly and respect its "avoid" synonyms. Key invariants:

- The `.vouch/` store is append-only and write-once: never delete or rewrite records; withdrawal is a Tombstone.
- Supersede only on full enclosure, never partial overlap (docs/adr/0001).
- Statuses are computed at render time, never stored; "dismissed" is machine-detected, never user-set (docs/adr/0002).
- Every review record field is untrusted input: HTML-escape before rendering, validate links, use `execFile` (never shell) for git.

## Workflow

- Conventional commits: `feat(core):`, `fix(vscode):`, `docs:`, `chore:`, etc.
- Validate and ship changes through the no-mistakes pipeline (`/no-mistakes`).
- Release: `package.json` version must equal the `v*` git tag or CI fails; version and CHANGELOG.md move together (Keep a Changelog format). Use `/release`.
