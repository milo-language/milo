---
name: workflow
description: Pull in the standard Milo dev loop (research → plan → implement → run → review → wrap-up) at the start of a task. Use when beginning any non-trivial change so gates and definition-of-done aren't skipped.
---

# Workflow

Load and follow `AGENT_WORKFLOW.md` (repo root) for this task. It is the canonical loop; this skill just guarantees it's pulled in and enforced.

## Do this now
1. Read `AGENTS.md` to route to the docs/skills for what you're touching.
2. Open a worksheet — copy `worksheets/TEMPLATE.md` to `worksheets/<date>-<slug>.md`. Record goal + plan there and keep it live (mandatory if running autonomously).
3. Work the loop in `AGENT_WORKFLOW.md`:
   - **Research** → understand the real code path; fix any doc that lied. Review gate: `scripts/agent_review.sh research` for non-trivial approaches.
   - **Plan** → write it in the worksheet, terse, end with open questions. Gate: `scripts/agent_review.sh plan`.
   - **Implement** → match `CONVENTIONS.md`; camelCase milo; feature = checker+lower+codegen+formatter+LSP; write targeted tests as you go.
   - **Run (mandatory)** → compile+run real fixtures/examples; `bun test`; `/verify`. Never claim done unrun.
   - **Review** → `scripts/agent_review.sh implementation` (different model, personas) + `/code-review`.
   - **Wrap-up** → full `bun test` + benchmarks; update stale docs (bump `last-verified`); commit worksheet + feedback with the code; tag `git tag ws/<slug>`.

## The one rule
Do not tell the user something works until you have run it and seen it work. Report failures with their output; name any skipped step.
