---
name: release
description: Cut a release - bump version, update CHANGELOG, tag, and push so CI publishes to the Marketplace and Open VSX.
disable-model-invocation: true
---

Release the extension. Target version: $ARGUMENTS (if empty, ask the user; suggest a semver bump based on unreleased changes).

CI (`.github/workflows/release.yml`) triggers on `v*` tags and fails if the tag does not equal `package.json` version, so the steps below must stay in sync.

1. Preconditions: on `main`, clean working tree, up to date with `origin/main`. Stop and report if not.
2. Run the gate locally - CI runs these and a failed tag-build is messy to redo: `npm run typecheck && npm run lint && npm test`.
3. Set the new version in `package.json` (no git tag yet): `npm version <version> --no-git-tag-version`.
4. Update `CHANGELOG.md` (Keep a Changelog format): move the `[Unreleased]` entries into a new `## [<version>] - <YYYY-MM-DD>` section, leave an empty `[Unreleased]` section, and update the link references at the bottom.
5. Commit both files: `release: bump version to <version>.`
6. Tag `v<version>` and show the user the commit + tag, then ask for confirmation before pushing.
7. Push: `git push origin main --follow-tags`. CI publishes to the VS Code Marketplace and Open VSX and attaches the `.vsix` to a GitHub release.
8. Watch the release workflow (`gh run watch` or `gh-axi run`) and report the result.
