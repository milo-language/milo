<!-- doc-meta
system: agent-workflow
purpose: the standard loop for working in this repo — research, plan, implement, run, review, wrap-up
key-files: AGENTS.md, CONVENTIONS.md, docs/testing.md, docs/agent-review.md, docs/worksheets/
update-when: the workflow changes, a new gate is added, or docs/feedback/ reveals a recurring miss
last-verified: 2026-07-11
-->

# Agent Workflow

Tag me with `@/AGENT_WORKFLOW.md` at the start of a task. This is the loop. It is opinionated on purpose: skipping steps is how regressions ship.

The one rule under all of it: **do not claim something works until you have run it.** Type-checks and green unit tests are necessary, not sufficient. This is a compiler — the app is the compiler; running it means compiling and executing real `.milo` programs.

## The loop

### 0. Orient (2 min)
- Read [AGENTS.md](AGENTS.md) to find the relevant docs/skills.
- Open a worksheet ([docs/worksheets/README.md](docs/worksheets/README.md)) — even for small tasks if autonomous. Record goal + plan there as you go so a fresh agent could take over.
- Skim the `doc-meta` of docs for the system you're touching. Grep: `grep -rl "system:" docs *.md`.

### 1. Research
- Understand before changing. Read the actual code path, not just its doc — then fix the doc if it lied.
- For stdlib work run `bun run src/main.ts api <terms>` before writing new APIs (don't reinvent).
- Check [docs/roadmap.md](docs/roadmap.md) before proposing a language feature.
- **Review gate (research):** for a non-trivial change, get a second-model sanity check on the approach — `scripts/agent_review.sh research`.

### 2. Plan
- Write the plan in the worksheet: files to touch, order, how you'll verify.
- Keep it concise (grammar-optional). End with unresolved questions.
- **Review gate (plan):** `scripts/agent_review.sh plan` for anything spanning multiple files or altering semantics.

### 3. Implement
- Match surrounding code: naming, comment density, idioms (see [CONVENTIONS.md](CONVENTIONS.md)).
- Milo code is **camelCase** (memory: repo-wide convention).
- Type checker runs before codegen — semantic errors belong in `checker.ts`, never codegen.
- Definition-of-done for a feature/bugfix includes the **formatter and LSP** — update them too.
- Write targeted tests *as you go* (see §Tests), don't batch them to the end.

### 4. Run — mandatory
Prove it end-to-end. Pick what fits:
- Fixture/example: `bun run src/main.ts run examples/<x>.milo` — compile + execute.
- **All examples must still build + run: `bun run scripts/run-examples.ts`.** Compiles every entrypoint (hard gate) and runs the ones annotated `// @run:`. If your change should exercise a specific example, add a `// @run: <args>` (and `// @stdin: <text>` if it reads input) so it actually runs, not just compiles. Any example that breaks fails here — that's the point.
- Full suite before commit: `bun test`. Targeted during iteration: `bun test tests/run.test.ts -t "<name>"`.
- Self-host changes: `sh scripts/selfhost.sh` first (the `.bin` is gitignored/stale), then the guarded selfhost tests. **Never run `.selfhost/milo-self.bin` bare** (CLAUDE.md guards).
- Use `/verify` to drive the affected flow, or `/run` to launch the app.

If it failed, say so with the output. Skipped a step? Say that. No hedging when it's genuinely done.

### 5. Review
- Self-review the diff. Then **cross-model review**: `scripts/agent_review.sh implementation` runs personas (correctness, security, performance, maintainability, AI-smells, + domain) — a *different* lens than the model that wrote the code. See [docs/agent-review.md](docs/agent-review.md).
- `/code-review` for a fast local diff pass.

### 6. Wrap-up
- **Run the full validation** before you call it done: `bun test`, `bun run scripts/run-examples.ts` (all examples build+run), relevant benchmarks, sweep if you touched many files.
- Update every doc your change made stale; bump `last-verified`.
- Commit (directly to `main` — no feature branches for Milo; per repo convention). One-line, lowercase, no "coded with claude". Commit the worksheet + any feedback with the work.
- Tag the commit with the worksheet name so it's findable later: `git tag ws/<worksheet-slug>`.
- Drop a line in [docs/feedback/README.md](docs/feedback/README.md) if the workflow itself got in your way — that's how it improves.

## Autonomous / night-shift mode
Running unattended? All of the above, plus: worksheet is non-negotiable and updated after every step; on any failure you can't resolve, write the blocker into the worksheet and stop rather than thrash; end with the full wrap-up validation so the tree is pristine on return.

## Quick command card
```
bun run src/main.ts run examples/hello.milo     # compile + run
bun test                                          # full suite
bun test tests/run.test.ts -t "arithmetic"        # one fixture
bun run scripts/run-examples.ts                   # every example builds + annotated ones run
bun run scripts/lint.ts --all                     # repo linter (--fix to auto-fix)
scripts/agent_review.sh implementation            # cross-model review
sh scripts/selfhost.sh                            # rebuild milo-self before selfhost work
```
