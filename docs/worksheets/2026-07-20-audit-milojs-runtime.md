# Worksheet: audit MiloJS and runtime

- **Slug / tag:** `ws/audit-milojs-runtime`
- **Started:** 2026-07-20
- **Status:** done
- **Related:** `docs/milojs-roadmap.md`, `examples/apps/milojs/README.md`

## Goal
Establish the current MiloJS compiler/runtime state from source, docs, and real build/test evidence; report working coverage, failures, and next priorities.

## Plan
1. Read MiloJS docs, entry points, test harnesses, and recent history.
2. Build the MiloJS entry points with the repo-local Bun and run targeted/full MiloJS tests under required guards.
3. Compare evidence with the roadmap, record gaps, and report findings without changing implementation unless a narrow build blocker requires it.

## Current state
Audit complete on `c09f532`. Both MiloJS binaries build; all scored engine fixtures pass in default and forced-GC modes; five runtime smokes pass. Fixed Linux stdlib/runtime blockers and updated stale MiloJS status docs. Full repo tests remain environment-blocked by missing Clang/bare-metal tools and an unbuilt selfhost binary.

## Log
- 2026-07-20 — Read repo routing, workflow, hard rules, and worksheet protocol. Found pre-existing untracked VSIX files and `examples/ai-guardrails/`; leave them untouched.
- 2026-07-20 — Located MiloJS under `examples/apps/milojs`, its roadmap/docs, runtime fixtures, and repo-local Bun at `~/.bun/bin/bun`.
- 2026-07-20 — Fixed `std/environ.linux.milo` importing `readFile` from the obsolete module, and corrected explicit green-task stack sizing in `std/runtime.milo`.
- 2026-07-20 — Found Linux native-stack exhaustion in the tree walker before its recursion guard; measured a call-depth limit of 20 that passes both recursive fixtures and makes runaway recursion catchable.
- 2026-07-20 — Fast-forwarded to `c09f532`; upstream independently landed the LLVM aggregate type-order fix. Resolved the comment-only stash conflict in favor of upstream.
- 2026-07-20 — Updated the README's obsolete synchronous-await section and added a dated current snapshot to the roadmap.
- 2026-07-20 — Verified both binaries, default and forced-GC engine suites, and runtime module/async/event-loop/builtin smokes. Full `bun test` was attempted and failed on missing host dependencies/artifacts; lint completed with pre-existing warnings only.
- 2026-07-20 — Located fbsource LLVM toolchains. `fbcode/rldi/nullsafe/nullsafe-clang` (LLVM 23) is the compatible compiler: embedded ARM and header integration tests pass with it. `std/dl` still has one runtime callback failure. Large combined fixture/example runs still exceed this VM's guarded concurrency and abort with `SIGABRT`.

## Decisions
- Use `PATH="$HOME/.bun/bin:$PATH"` rather than reinstalling Bun.
- Treat this as an evidence-gathering audit; do not alter MiloJS implementation unless needed to resolve a narrow build blocker.

## Blockers / open questions
- QuickJS sweep not run: `~/git/quickjs/tests` is absent.
- Full repo suite cannot be green in this environment: use fbsource `nullsafe-clang` to supply Clang/bare-metal targets, but `.selfhost/milo-self.bin` is not built, `std/dl` has one runtime failure, and large parallel fixture/example/prover runs exceed the VM's guarded-process capacity.

## Verification
- [x] targeted tests: MiloJS expected-output suite, default and `MILOJS_GC_THRESHOLD=1`; all scored fixtures pass, `membench` intentionally unscored
- [x] ran the app / fixture: built engine + runtime; runtime `modules`, `asyncOrdering`, `eventLoop`, `bufferStream`, and `cryptoMod` match expected output
- [ ] full `bun test`: attempted; initial run 304 pass / 8 skip / 766 fail / 1 error. With fbsource `nullsafe-clang`, embedded/header targeted tests pass (17 pass / 3 skip / 1 unrelated `std/dl` runtime failure); selfhost and high-concurrency full-suite blockers remain
- [ ] agent review: not run
- [x] docs updated (last-verified bumped): `examples/apps/milojs/README.md`, `docs/milojs-roadmap.md`
