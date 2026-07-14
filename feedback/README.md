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
