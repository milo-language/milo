---
name: commit-sweep
description: Periodically sweep recent commits for cross-cutting problems, gotchas, and regressions that per-commit review misses. Use to audit the last N commits from a higher level (e.g. weekly, or before a release).
---

# Commit Sweep

Per-commit review sees one diff at a time. This sweep looks *across* recent commits for the problems that only show up in aggregate: a pattern applied inconsistently, a fix that regressed something two commits later, docs that drifted from code, tests that went quiet.

## Procedure
1. **Pick the window.** Default last 15 commits: `git log --oneline -15`. Get the combined diff: `git diff HEAD~15..HEAD`.
2. **Sweep for, specifically:**
   - **Inconsistency** — same idea done differently across commits (naming, error handling, a helper reimplemented instead of reused). Grep to confirm it's a pattern, not a one-off.
   - **Silent regressions** — a later commit that partially reverted or broke an earlier fix. Check whether the earlier fix still has a test guarding it.
   - **Guard/safety drift** — any new bare milo-self run, `MILO_RUN_UNGUARDED`, raised mem/concurrency caps (CLAUDE.md). Run `bun run scripts/lint.ts --all`.
   - **Doc drift** — for each touched system, does its doc's `doc-meta` `key-files` still match reality? Is `last-verified` stale? (docs/doc-standards.md)
   - **Test coverage that quietly shrank** — new behavior with no fixture; a `.skip` that slipped in; a fixture whose `@expect` would pass even if the feature were deleted (docs/testing.md false-confidence check).
   - **TODO/FIXME left behind** without an owner or issue.
3. **Verify before reporting.** For each suspected issue, confirm it (grep, run the fixture, break-and-test). Don't report speculation — this is where a second-model check helps: `scripts/agent_review.sh implementation --diff HEAD~15`.
4. **Report** as a terse list: `commit <sha> · file:line · problem · fix`. Group by theme. File anything mechanical into `scripts/lint.ts` and anything judgmental into `CONVENTIONS.md` so it's caught automatically next time.
5. **Log** recurring findings in `docs/feedback/README.md` so the workflow tightens.

## Output
A ranked list, most-severe first, each with a concrete fix. If clean, say so and note what you checked — a sweep that finds nothing should still show its work.
