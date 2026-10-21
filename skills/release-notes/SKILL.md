---
name: release-notes
description: Write release notes and changelogs from commits, pull requests or a diff. Use when cutting a release, writing a changelog entry, or announcing changes to users.
mcps: [coding]
---

## Gather
1. Collect the changes since the last release (git log <last-tag>..HEAD, merged PRs).
2. Group them: new, improved, fixed, breaking, security.
3. Drop internal-only changes (refactors, CI) unless they affect users.

## Write
- Lead each item with the user-visible effect, not the implementation.
- Call out breaking changes first with the migration step.
- Keep one line per item; link the PR or issue.
- Match the existing CHANGELOG format when there is one.
