<!-- doc-meta
system: agent-router
purpose: entry point that routes any agent to the right skill, doc, script, or convention
key-files: AGENT_WORKFLOW.md, CONVENTIONS.md, CLAUDE.md, docs/, scripts/, docs/worksheets/
update-when: a new skill/doc/script/convention is added, or a routing entry goes stale
last-verified: 2026-07-23
-->

# AGENTS.md — Router

**Read this first.** This file routes you to the right place. It is not the work itself — it points at the work. `CLAUDE.md` holds the hard operational rules (memory guards, build commands, architecture); this file holds the map. When they conflict, `CLAUDE.md` wins.

Every doc in this repo starts with a 7-line `<!-- doc-meta ... -->` block. To find the doc for a system, grep it: `grep -rl "system: <name>" docs AGENTS.md *.md`. Keep meta blocks true — see [docs/doc-standards.md](docs/doc-standards.md).

## Start every session here

1. **What am I doing?** → open a worksheet: [docs/worksheets/README.md](docs/worksheets/README.md). Autonomous/async work: the worksheet is mandatory — another agent must be able to finish from it alone.
2. **How do I work in this repo?** → [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) (the loop: research → plan → implement → run → review → wrap-up).
3. **What are the rules?** → [CLAUDE.md](CLAUDE.md) (guards, commands) + [CONVENTIONS.md](CONVENTIONS.md) (code style reviewers enforce).

## Route by intent

| I want to… | Go to |
|---|---|
| Understand the workflow / how to approach a task | [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) |
| Know the coding conventions reviewers check | [CONVENTIONS.md](CONVENTIONS.md) |
| Write idiomatic Milo (text handling, ownership, control flow) | [docs/milo-idioms.md](docs/milo-idioms.md) |
| Do a lifetime-shaped thing (linked list, graph, tree, recursive type, zero-copy) | [docs/ownership-model.md](docs/ownership-model.md) §Rust→Milo — slices, `Heap<T>`, `std/arena` all exist; check here before assuming a gap |
| Know what memory-safety Milo catches (compile vs runtime) vs Rust | [docs/memory-safety-vs-rust.md](docs/memory-safety-vs-rust.md) — battle-test matrix, 13 probes, zero UB misses |
| Write or run tests, or find what's covered | [docs/testing.md](docs/testing.md) |
| Run the compiler / prove a change works | [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) §Run, `bun run scripts/run-examples.ts`, `/verify`, `/run` |
| Get my work reviewed by a different model | [docs/agent-review.md](docs/agent-review.md) → `scripts/agent_review.sh` |
| Add a helper script / bin tool | [docs/scripts.md](docs/scripts.md) |
| Write or update a system doc | [docs/doc-standards.md](docs/doc-standards.md) |
| Track / hand off in-progress work | [docs/worksheets/README.md](docs/worksheets/README.md) |
| Leave you feedback about the workflow | [docs/feedback/README.md](docs/feedback/README.md) |
| Sweep recent commits for regressions | skill `/commit-sweep` |
| Debug an emulator bug (black screen, garbled gfx, freeze) | skill `/emu-debug` |
| Understand the compiler internals | [CLAUDE.md](CLAUDE.md) §Architecture, [docs/design.md](docs/design.md) |
| The language spec / grammar | [docs/language-reference.md](docs/language-reference.md), [docs/grammar.ebnf](docs/grammar.ebnf) |
| What's planned / allowed to build | [docs/roadmap.md](docs/roadmap.md) — check before proposing features |
| Move or rename a public stdlib name | record it in [docs/breaking-changes.md](docs/breaking-changes.md) — the flat namespace makes compat shims impossible, so the doc is the only migration path users get |
| Find an stdlib API | `bun run src/main.ts api <terms>` |

## Org layout (`milo-language`)

This repo is one of five in the `milo-language` GitHub org. They are **independent repos, not
submodules** — there is no `.gitmodules` and nothing here builds from their source. Don't add
submodules for them; they are separate products that happen to be written in Milo.

| Repo | Contents | Local clone |
|---|---|---|
| `milo` | Compiler, stdlib, docs, examples (this repo) | `~/git/milo` |
| `milojs` | JS engine + runtime written in Milo | `~/git/milo-language/milojs` |
| `emulators` | NES/SNES/Genesis cores + console front-end | `~/git/milo-language/emulators` |
| `dapweb` | DAP debugger + web UI (formerly named `hades`) | `~/git/milo-language/dapweb` |
| `.github` | Org profile README = the org homepage | `~/git/milo-language/.github` |

Push to main is allowed org-wide. Note `milo` itself sits at `~/git/milo`, *outside*
`~/git/milo-language/` — it predates the layout and has live worktrees under
`.claude/worktrees/`, so moving it would break them.

Three traps in the paths above:

- `~/git/milo/examples/emulators` is **in-repo example code**, not the `emulators` repo.
- `~/git/milo-blackhat` is a second clone of `milo-language/milo`, not a separate project.
- `~/git/hades` is a local-only leftover from before the `hades` → `dapweb` rename. It has
  **no git remote** and carries commits whose subjects appear nowhere in `dapweb`. It is not
  a clone of `dapweb`, and `dapweb` has since been reworked past it (mcp → api). Don't treat
  the two as interchangeable.

### Marketing copy lives in five places

The tagline is **"A memory-safe systems language that guides you to correct, readable
programs."** Changing it means changing all four places that carry it. Note the last entry is
GitHub metadata, not a file, so grep will never find it:

1. `README.md` (this repo)
2. `docs/site/index.md` — hero `text:`, plus the intro paragraph. The hero `tagline:` field
   below it carries the verification pitch, not the tagline.
3. `docs/site/.vitepress/config.mts` — `description:` (drives SEO + social cards)
4. `profile/README.md` in the `.github` repo (org homepage) — deliberately minimal: tagline
   plus a docs link, nothing else. GitHub already lists the org's repos below it, so a repo
   table there is redundant.
5. **Repo description metadata is deliberately NOT the tagline.** It is the bare
   `The Milo Programming Language` (Odin's convention — bare repo description, pitch lives on
   the site). Don't "fix" it to match the tagline.
   Set via `gh repo edit milo-language/milo --description "..."`.

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
