<!--
Sync Impact Report
Version change: (unfilled template) → 1.0.0
Rationale: initial ratification; all placeholder tokens replaced with concrete project rules.
Modified principles:
  [PRINCIPLE_1_NAME] → I. Memory Safety Is the Product (NON-NEGOTIABLE)
  [PRINCIPLE_2_NAME] → II. The Checker Owns Every Semantic Error
  [PRINCIPLE_3_NAME] → III. Nothing Works Until It Has Been Run
  [PRINCIPLE_4_NAME] → IV. Generate It, Don't Restate It
  [PRINCIPLE_5_NAME] → V. Done Spans the Whole Toolchain
Added sections:
  [SECTION_2_NAME] → Safety and Platform Constraints
  [SECTION_3_NAME] → Development Workflow and Quality Gates
Removed sections: none
Follow-up TODOs: none
-->

# Milo Constitution

## Core Principles

### I. Memory Safety Is the Product (NON-NEGOTIABLE)

Safe Milo code MUST have no GC, no reference counting, and no pointers. Ownership is single-owner
with move semantics; use-after-move MUST be a compile error. References are second-class: `&T` /
`&mut T` appear only in function parameters, never stored and never returned. Raw pointers come
from explicitly `unsafe` operations (`v.ptr()`, `x.addrOf()`), never from a `&` expression.

Every safety rule MUST be expressible as a property of the program, not as a list of node kinds,
function names, or type tags that happen to be handled. A rule keyed to one spelling of an
operation is a defect: the recurring failure in this codebase is a check that matched one shape
while the same operation spelled another way walked past it. Every "unknown / can't tell / didn't
match" path MUST reject, not accept. Silently doing something other than what the source says is
the worst available outcome and outranks a false rejection.

Overflow and bounds checking are on by default. A global flag that disables them MUST NOT be added.

### II. The Checker Owns Every Semantic Error

Type checking, move checking, and scope validation run before codegen. A semantic error MUST be
caught in `src/checker.ts`; if codegen can reach an invalid state, the checker missed it and the
checker is what gets fixed. Codegen MUST NOT be the place a program is rejected.

When a user gets something wrong, they MUST see a diagnostic that names the cause and points at a
fix, anchored to a real source span. An LLVM verifier error, a crash with no source location,
garbage output, or a silent fallback to a plausible-looking value is not guidance, however
internally correct the compiler was.

### III. Nothing Works Until It Has Been Run

A change MUST NOT be reported as working on the strength of a type-check or a green unit test
alone. The application here is the compiler, so "run" means compiling and executing real `.milo`
programs. Before a change is called done, the gates that its blast radius touches MUST have been
executed and observed to pass:

- `bun test` for compiler and stdlib changes; `bun test tests/run.test.ts -t "<name>"` while iterating.
- `bun run scripts/run-examples.ts`: every example builds, annotated ones run.
- `sh scripts/selfhost.sh` plus the fixpoint, soundness, and HIR gates for any `src-milo/`, `std/`,
  or selfhost-script change.

Failures MUST be reported with their actual output. A skipped step MUST be named as skipped. Every
gate MUST be able to fail: a gate whose parser stopped matching, that reports "0 checked", or that
cannot fail for the behavior it names is a defect and MUST be fixed or deleted, not left green.

### IV. Generate It, Don't Restate It

Any count, list, signature, table, or index that describes the code MUST be generated from the code
(`scripts/gen-*.ts`) or compared against it by a test. A hand-typed second copy of something the
compiler already knows is the defect, not the gap it fills.

Tooling that needs compiler knowledge (doc gates, editor grammars, linters, agents) MUST consume
`milo api --json`, `milo lang --json`, or `milo check --json` rather than importing `src/*.ts`.
Importing compiler internals pins the tool to the host language; the JSON surface survives a
rewrite.

### V. Done Spans the Whole Toolchain

A new language feature is not complete at checker + lower + codegen. The formatter and the LSP are
part of the definition of done, not a follow-up. A new test is added by dropping a `.milo` file
with `// @expect:` or `// @error:` annotations into `tests/fixtures/` or `tests/errors/`, with no
driver changes; tests are written as the work proceeds, not batched at the end.

Public stdlib capability lands *alongside* existing APIs rather than silently changing their
contract. A deliberate pre-1.0 coherence migration MUST migrate the whole domain at once and record
the break in `docs/breaking-changes.md`; the flat namespace makes compatibility shims impossible,
so that document is the only migration path users get.

## Safety and Platform Constraints

**Host-machine memory guards are OS-safety rules and MUST NOT be weakened.** macOS enforces no
rlimits, so a runaway allocation takes down the machine. `.selfhost/milo-self.bin` MUST NEVER be
run bare; use the self-guarding `.selfhost/milo-self` wrapper, or `bun scripts/guard.ts`.
`MILO_RUN_UNGUARDED=1` MUST NOT be committed. Sweep/test concurrency and per-child memory caps MUST
NOT be raised without redoing the arithmetic in `scripts/guard.ts` (N workers × cap stays under half
of RAM). Pressure kills are fail-closed by design.

**Self-host never gates a `src/` change.** A language or stdlib feature lands in `src/` with
`bun test tests/run.test.ts`; `src-milo/` may lag, and that is acceptable. The relationship is
one-way: a change *to* `src-milo/` IS gated by the selfhost fixpoint and ratchets.

**Platform variation is expressed by filename suffix**, not by `#[cfg]`, `#ifdef`, or an inline
`process.platform` branch. Every platform arm MUST export the same surface. A name a platform
cannot implement still has to exist there and MUST fail loudly (link error naming the symbol, or an
explicit abort), never return a plausible-looking value.

**Language surface is bounded by the roadmap.** `docs/roadmap.md` MUST be consulted before a
language feature is proposed. Decisions recorded there as rejected are not reopened without an
amendment to this constitution or new evidence stated in the proposal.

## Development Workflow and Quality Gates

Work follows the loop in `.agents/workflow.md`: research → plan → implement → run → review → wrap-up.
Autonomous or long-running work MUST keep a worksheet under `.agents/worksheets/` current enough that
a fresh contributor could finish from it alone.

**Ethos review is mandatory before wrap-up.** Milo is "a memory-safe systems language that guides
you to correct, readable programs." The author MUST argue the change violates that sentence, on
each clause (memory-safe / guides you / correct / readable), answering with evidence from the diff
rather than intent. The strongest objection found and its answer MUST be written into the
worksheet. "No objections" means the review did not happen.

Code review, meaning self-review of the diff plus a cross-model pass
(`scripts/agent_review.sh implementation`), MUST precede commit for any non-trivial change.

Commits go directly to `main`; there are no feature branches in this repo. Commit messages are one
lowercase line. Shared history MUST NOT be force-pushed. Commit the worksheet and any workflow
feedback with the work, and tag with `ws/<slug>`. Docs made stale by a change MUST be updated in the
same commit, with `last-verified` bumped.

Milo code is camelCase repo-wide. Comments explain the why (constraints, invariants, workarounds,
surprises), never the what. Commented-out code, stray debug logging, and committed `test.only` /
unexplained `.skip` MUST NOT land.

## Governance

This constitution supersedes other practice documents on the matters it covers. Where it is silent
on an operational detail, `CLAUDE.md` is authoritative (build commands, guards, architecture), then
`AGENTS.md` as the router, then `CONVENTIONS.md` for style.

**Amendments** are made by editing `.specify/memory/constitution.md` with a Sync Impact Report
prepended, in a commit that states the rationale. An amendment that removes or redefines a
principle MUST also state what now enforces the behavior that principle protected, or explicitly
record that it is no longer protected.

**Versioning** follows semantic versioning of governance scope:
- MAJOR: a principle is removed or redefined in a backward-incompatible way.
- MINOR: a principle or section is added, or guidance is materially expanded.
- PATCH: clarification, wording, or typo fixes with no change in obligation.

**Compliance** is verified at review time. A reviewer MUST be able to name which principle each
objection rests on. Added complexity MUST be justified against Principle I or II; "it was easier"
is not a justification. A gate that this constitution requires but that cannot fail is treated as a
constitution violation, not a test bug.

**Version**: 1.0.0 | **Ratified**: 2026-08-21 | **Last Amended**: 2026-08-21
