<!-- doc-meta
system: agent-feedback
purpose: append-only log where agents flag workflow friction; the human periodically ingests it to improve the system
key-files: AGENT_WORKFLOW.md, AGENTS.md, CONVENTIONS.md, scripts/lint.ts, docs/agent-review.md
update-when: an agent hits workflow friction (append), or the human triages entries (mark resolved)
last-verified: 2026-07-11
-->

# Agent Feedback

Append-only. At the end of a session, if the *workflow itself* got in your way — a doc that lied, a missing script, a rule that fought you, a review persona that only produced noise, a step that was busywork — write it here. This is committed with the work. The human periodically reads it in an interactive session and folds the good signal back into the workflow, then marks entries resolved.

This is not a bug tracker for the code (that's the task queue / worksheets). It's a tracker for **the way we work**.

## How to add an entry
Append a block at the bottom. Be specific and actionable — "the review step was slow" is noise; "agent_review.sh runs all 7 personas serially, ~90s; let me select a subset by default for small diffs" is signal.

```
### <YYYY-MM-DD> — <short title>  [open]
- **Friction:** what got in the way, concretely.
- **Cost:** time wasted / mistake it caused / thing it hid.
- **Proposed fix:** the change to a doc/script/rule that would prevent it. (Optional.)
```

Triage: the human flips `[open]` → `[resolved: <what changed>]` or `[wontfix: <why>]` and, if actioned, updates the relevant doc/script.

## Entries

<!-- newest at the bottom -->

### 2026-07-11 — bootstrap  [resolved: initial system created]
- **Friction:** n/a — seed entry establishing the format.
- **Proposed fix:** n/a.

### 2026-07-14 — filtered single-fixture runs (`bun test -t <name>`) spuriously fail  [open]
- **Friction:** `bun test tests/run.test.ts -t "vecStringLiveGrow"` fails with empty
  stdout (expected `172032 100`), but the identical binary passes standalone, under
  the guard, 24-way parallel, and in the FULL suite. Cause: the driver's `beforeAll`
  builds *all* ~449 fixtures concurrently even for a filtered run, then immediately
  runs the one selected binary while the machine is still in the build storm's
  memory-pressure tail; `scripts/guard.ts` is fail-closed on system pressure and
  SIGKILLs the largest guarded tree — catching the lone run. Then the runtime's
  lost-stdout-on-abnormal-exit (lang-friction #2) turns the kill into silent empty
  output, so it reads as a crash / regression rather than "guard-killed."
- **Cost:** ~30 min this session chasing a "resurrected" memory-safety bug that was
  actually fixed; anyone debugging a single fixture will hit the same false alarm.
- **Proposed fix:** (a) don't build all fixtures in `beforeAll` for a filtered run —
  build only the selected file(s); and/or (b) flush stdout on the guard's kill path
  and have `runWithRetry` surface `signal`/`killReason` so a guard kill reports as
  such instead of an empty-stdout mismatch (this is lang-friction #2 — worth fixing
  regardless).
