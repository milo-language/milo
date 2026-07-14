<!-- doc-meta
system: agent-router
purpose: entry point that routes any agent to the right skill, doc, script, or convention
key-files: AGENT_WORKFLOW.md, CONVENTIONS.md, CLAUDE.md, docs/, scripts/, worksheets/
update-when: a new skill/doc/script/convention is added, or a routing entry goes stale
last-verified: 2026-07-11
-->

# AGENTS.md — Router

**Read this first.** This file routes you to the right place. It is not the work itself — it points at the work. `CLAUDE.md` holds the hard operational rules (memory guards, build commands, architecture); this file holds the map. When they conflict, `CLAUDE.md` wins.

Every doc in this repo starts with a 7-line `<!-- doc-meta ... -->` block. To find the doc for a system, grep it: `grep -rl "system: <name>" docs AGENTS.md *.md`. Keep meta blocks true — see [docs/doc-standards.md](docs/doc-standards.md).

## Start every session here

1. **What am I doing?** → open a worksheet: [worksheets/README.md](worksheets/README.md). Autonomous/async work: the worksheet is mandatory — another agent must be able to finish from it alone.
2. **How do I work in this repo?** → [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) (the loop: research → plan → implement → run → review → wrap-up).
3. **What are the rules?** → [CLAUDE.md](CLAUDE.md) (guards, commands) + [CONVENTIONS.md](CONVENTIONS.md) (code style reviewers enforce).

## Route by intent

| I want to… | Go to |
|---|---|
| Understand the workflow / how to approach a task | [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) |
| Know the coding conventions reviewers check | [CONVENTIONS.md](CONVENTIONS.md) |
| Write or run tests, or find what's covered | [docs/testing.md](docs/testing.md) |
| Run the compiler / prove a change works | [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) §Run, `bun run scripts/run-examples.ts`, `/verify`, `/run` |
| Get my work reviewed by a different model | [docs/agent-review.md](docs/agent-review.md) → `scripts/agent_review.sh` |
| Add a helper script / bin tool | [docs/scripts.md](docs/scripts.md) |
| Write or update a system doc | [docs/doc-standards.md](docs/doc-standards.md) |
| Track / hand off in-progress work | [worksheets/README.md](worksheets/README.md) |
| Leave you feedback about the workflow | [feedback/README.md](feedback/README.md) |
| Sweep recent commits for regressions | skill `/commit-sweep` |
| Debug an emulator bug (black screen, garbled gfx, freeze) | skill `/emu-debug` |
| Understand the compiler internals | [CLAUDE.md](CLAUDE.md) §Architecture, [docs/design.md](docs/design.md) |
| The language spec / grammar | [docs/language-reference.md](docs/language-reference.md), [docs/grammar.ebnf](docs/grammar.ebnf) |
| What's planned / allowed to build | [docs/roadmap.md](docs/roadmap.md) — check before proposing features |
| Find an stdlib API | `bun run src/main.ts api <terms>` |

## Skills (`.claude/skills/`)

| Skill | Use when |
|---|---|
| `/workflow` | starting a task and you want the standard loop pulled in |
| `/commit-sweep` | periodically auditing recent commits for gotchas/regressions |
| `/emu-debug` | diagnosing NES/SNES/Genesis emulator bugs — headless harnesses, triage ladder, oracles |

Built-in skills worth knowing: `/verify` (drive a change end-to-end), `/run` (launch the app), `/code-review` (diff review).

## Persona → doc ownership

Review personas own the docs for their domain and keep them current (see [docs/agent-review.md](docs/agent-review.md)):

- **correctness / compiler** → `docs/design.md`, `docs/language-reference.md`, `CLAUDE.md`
- **testing** → `docs/testing.md`
- **performance** → `benchmarks/`, perf notes in `docs/design.md`
- **safety / memory** → `docs/safety-roadmap.md`, guard rules in `CLAUDE.md`
- **maintainability / DX** → `CONVENTIONS.md`, `docs/scripts.md`

## Self-healing rule

If you touch a system and its doc is wrong or missing, **fix the doc in the same change**. A stale doc is a bug. Update the `last-verified` line when you confirm a doc still matches reality.
