<!-- doc-meta
system: worksheets
purpose: per-task agent worksheets — a live trace another agent can resume from if this one dies
key-files: docs/worksheets/TEMPLATE.md, AGENT_WORKFLOW.md
update-when: the worksheet schema or the resume/hand-off protocol changes
last-verified: 2026-07-11
-->

# Worksheets

A worksheet is the running trace of one task: goal, plan, decisions, and current state, updated *as you go*. Its one job: **if this agent dies mid-task, a fresh agent can pick up the worksheet and finish** — no other context needed. That's the bar for how much detail to write.

You will reference these later (why a change was made, what was tried). They're committed with the work and tagged, so they stay connected to the diff.

## Protocol
1. **Start of task:** copy `TEMPLATE.md` to `docs/worksheets/<YYYY-MM-DD>-<slug>.md`. Fill in goal + plan.
2. **As you work:** append to the log after each meaningful step — what you did, what you learned, what's next. Keep "Current state" accurate; it's what a resuming agent reads first.
3. **On a blocker you can't resolve (autonomous mode):** write the blocker + what you tried into the worksheet and stop. Don't thrash.
4. **On finish:** mark done, commit the worksheet *with* the code change, and tag: `git tag ws/<slug>`. The tag makes the worksheet (and its diff) findable later: `git tag -l 'ws/*'`.

## Naming
`docs/worksheets/2026-07-11-fix-move-checker-clone-hint.md` — date + kebab slug. The slug is also the git tag (`ws/fix-move-checker-clone-hint`).

## Resuming someone else's worksheet
Read "Current state" and the log tail. Continue the log with your own entries. Don't rewrite history — append. If the plan was wrong, note why and revise it in place with a dated entry.
