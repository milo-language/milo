<!-- doc-meta
system: agent-router
purpose: entry point that routes any agent to the right skill, doc, script, or convention
key-files: AGENT_WORKFLOW.md, CONVENTIONS.md, CLAUDE.md, docs/, scripts/, docs/worksheets/
update-when: a new skill/doc/script/convention is added, or a routing entry goes stale
last-verified: 2026-09-20 (memory-safety row: sweep findings #3-#9 and the fuzzer gates)
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
| Know what memory-safety Milo catches (compile vs runtime) vs Rust, or what it deliberately does not check | [docs/memory-safety-vs-rust.md](docs/memory-safety-vs-rust.md): battle-test matrix, 13 probes; finding #2 (move-out-of-borrow UAF) closed 2026-07-31, findings #3-#9 (the September soundness sweep: shard copy, owner-under-worker, global across a park, `ptr()` past a realloc, Drop copy-out, channel leak, impl-vs-trait signature) closed 2026-09-19/20. The sweep is fuzzer-gated now (`fuzz:tasks`, `fuzz:generic-drop` and the ASan sweep run in CI), scoped, not a no-UB proof; its last section is the three gaps Rust's stored references cover and Milo does not |
| Write or run tests, or find what's covered | [docs/testing.md](docs/testing.md) |
| Changing `src/verify.ts` or `src/prove-milo.ts` | ALWAYS run `bun test tests/verify-contracts.test.ts` before merging, whatever else is skipped: it is the only gate that notices a lost proof (WP6 lost four in `std/inflate.milo` and three merges went by) |
| Changing `src/checker.ts` rules | ALWAYS run `bun run scripts/run-examples.ts` before merging: a false positive on a real program is a rule not finished |
| Measure what the ownership model costs real programs (non-FFI `unsafe`, clones, friction comments) | `bun scripts/corpus-census.ts` over every `.milo` in the org; `--check` is the shrink-only gate on non-FFI `unsafe`, `--comments` lists each block's reason. Findings in [docs/memory-safety-vs-rust.md](docs/memory-safety-vs-rust.md) §What the corpus says |
| Hunt for compiler crashes / hangs on hostile input | `bun scripts/fuzz-frontend.ts` — token-mutation fuzzer over the fixture corpus, ddmin-reduced findings; `bun scripts/prove-soundness-fuzz.ts` for false proofs out of `milo prove`; `bun run fuzz:tasks` for unsafe-free programs the checker accepts that ASan then rejects (globals across parks, Shards windows past their owner, `ptr()` past a realloc) |
| Run the compiler / prove a change works | [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) §Run, `bun run scripts/run-examples.ts`, `/verify`, `/run` |
| Get my work reviewed by a different model | [docs/agent-review.md](docs/agent-review.md) → `scripts/agent_review.sh` |
| Add a helper script / bin tool | [docs/scripts.md](docs/scripts.md) |
| Write or update a system doc | [docs/doc-standards.md](docs/doc-standards.md) |
| Track / hand off in-progress work | [docs/worksheets/README.md](docs/worksheets/README.md) |
| Leave you feedback about the workflow | [docs/feedback/README.md](docs/feedback/README.md) |
| Sweep recent commits for regressions | skill `/commit-sweep` |
| Debug an emulator bug (black screen, garbled gfx, freeze) | skill `/emu-debug` |
| Write or talk about Milo externally (blog, talk, README pitch) | [docs/design-insights.md](docs/design-insights.md) (the arguments, each with its falsifier) |
| Understand the compiler internals | [CLAUDE.md](CLAUDE.md) §Architecture, [docs/design.md](docs/design.md) |
| The language spec / grammar | [docs/language-reference.md](docs/language-reference.md) (prose), [docs/spec.md](docs/spec.md) (normative requirements, generated), [docs/grammar.ebnf](docs/grammar.ebnf) (syntax) |
| Look up a compile error, or see what a rule rejects | [docs/errors.md](docs/errors.md) — every pinned message with the program that provokes it (generated from `tests/errors/`) |
| What's planned / allowed to build | [docs/roadmap.md](docs/roadmap.md) — check before proposing features |
| Move or rename a public stdlib name | record it in [docs/breaking-changes.md](docs/breaking-changes.md) — the flat namespace makes compat shims impossible, so the doc is the only migration path users get |
| Find an stdlib API | `bun run src/main.ts api <terms>` |
| Design or review a public stdlib API | [docs/stdlib-design.md](docs/stdlib-design.md) |
| Pick up stdlib gap/inconsistency work | [docs/stdlib-audit-2026-08.md](docs/stdlib-audit-2026-08.md) — tiered checkbox tracker vs Go/Rust/Node |

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

**After a compiler or std change, run the packages' own suites** —
`sh scripts/check-packages.sh` (one arg runs a single package). It runs the sibling Milo
packages' test suites — yaml, toml, markdown, aws, milo-json-rpc and friends — against
this checkout. Those were written by people solving a different problem and reach std
through APIs no fixture here calls: 72 tests that this repo's own suite says nothing
about. Missing checkouts skip, so it is safe to run anywhere; suites needing a live
service (postgres, redis, aws/s3) skip by name rather than by guessing from the error.

**After a compiler change to codegen, closures, the scheduler or `std/runtime`, run
milojs's app check** — `tools/check-apps.sh` in `~/git/milo-language/milojs` (one arg
runs a single app). It boots real applications (an express + Prisma + tRPC server, and an
express + ws chat) under node and under milojs and diffs the served bytes. Three defects
have reached it that BOTH repos' fixture suites missed, which is the point: this repo's
874 fixtures exercise a few dozen concurrency shapes, and a closure or scheduler change
touches every capturing closure in every program. A missing app checkout skips rather
than fails, so it is safe to run anywhere.

Three traps in the paths above:

- The emulators and the debugger were deleted from `examples/` once they got their own repos —
  `examples/emulators` and `examples/tools/hades` are gone from `main`, so work on them in the
  clones above. Untracked leftovers (ROMs, `node_modules`, built binaries) may still sit at the
  old paths on this machine; they are not the source.
- `~/git/milo-blackhat` is a second clone of `milo-language/milo`, not a separate project.
- `~/git/hades` is a local-only leftover from before the `hades` → `dapweb` rename. It has
  **no git remote** and carries commits whose subjects appear nowhere in `dapweb`. It is not
  a clone of `dapweb`, and `dapweb` has since been reworked past it (mcp → api). Don't treat
  the two as interchangeable.

### Marketing copy lives in five places

The tagline is **"A memory-safe systems language with second-class references: no
lifetimes, no GC, one owner per value."** Changing it means changing all four places that carry it. Note the last entry is
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

## Generate it, don't restate it

**A fact stated in prose is a fact that will be wrong.** Every count, list, signature,
table and index in this repo that describes the code must either be *generated from the
code* or *gated by a test that compares it to the code*. Hand-synced copies always drift,
and they drift silently — the docs site shipped a syntax grammar that highlighted three
keywords Milo does not have, the argparse page documented a free-function API that never
existed, and the front-page benchmark table disagreed with the hyperfine output sitting
next to it in the same directory.

Before you add a claim about the code to any doc, ask which of these it is:

| Claim | Mechanism | Example |
|---|---|---|
| a count | `<!-- stat:<name> -->N<!-- /stat -->` marker | `scripts/gen-stats.ts`, gated by `tests/docStats.test.ts` |
| a list of files | project it from the files' own headers | `scripts/gen-src-doc.ts`, `scripts/gen-scripts-doc.ts` |
| an API signature | generate from doc-comments, or gate against the real API | `scripts/gen-std-docs.ts`, `scripts/check-api-docs.ts` |
| a measured number | one source file, rendered into every place it appears | `benchmarks/results.json` → `scripts/gen-benchmarks.ts` |
| a code snippet | make it compile in the doc-test harness | `tests/docs.test.ts` (```` ```milo ```` fences) |
| a keyword/token list | derive it from `src/tokens.ts` | `scripts/gen-tmlanguage.ts`, `tests/grammar.test.ts` |
| a link to a file | `tests/docLinks.test.ts` checks it resolves | — |

If none fits, write the gate before you write the claim. Two rules that follow from this:

- **One copy.** If a value has to appear twice, the second copy is generated from the
  first. Never two hand-edited copies of the same table (that is how the docs site ran on
  a stale grammar for months).
- **A generator's CLI half must be behind `if (import.meta.main)`** — a test that imports
  it and thereby rewrites the file it is checking proves nothing.

And the corollary for *tools*: read the compiler through its machine-readable surfaces
(`milo api --json`, `milo lang --json`, `milo check --json`, `emit-ast`, `emit-hir`), not
by importing `src/*.ts`. An importer can only ever be a file inside this repo written in
this repo's current host language — which is TypeScript today and is planned to be Rust or
Milo. See [docs/json-api.md](docs/json-api.md) for the payloads and the rules that keep
them honest.
