# Self-Hosting Plan (v2 — 2026-07-08)

Goal: `milo-self` (the Milo compiler written in Milo, in `src-milo/`) compiles
itself, and the bootstrap converges. This doc is written to be executable by an
implementing agent with no other context: every milestone has a command-line
acceptance test, and the rules in "Working Agreement" are mandatory.

## Current State (verified empirically 2026-07-08)

- `src-milo/` is ~8,220 lines across 18 files. Pipeline in `main.milo`:
  `tokenize → parse → resolveImports → checkProgram → genProgram(AST)`.
  Commands: `build`, `run`, `emit-ir`, `check`.
- **It compiles** with the TS compiler (`bun run src/main.ts build
  src-milo/main.milo -o milo-self`, ~2.3s) **but crashes at runtime on every
  input**, including `fn main(): i32 { return 0 }` — varying signals
  (SIGSEGV/SIGABRT/SIGKILL) suggest memory corruption or runaway allocation.
  Last src-milo commit (c7ef5ea, 2026-07-07, "checker state reworked to
  copy-back lookups") is the prime suspect but is unverified — there is no
  test harness, so the breakage landed silently.
- Phase completeness: lexer/parser done; checker largely done (expr, stmt,
  mono, traits); codegen is **AST-directed and partial** — no `for`-in, no
  `if let`, no `!` (unwrap), no `?` (propagate), no index assignment
  (TODOs at `codegen/stmt.milo:33,237,267`, `codegen/expr.milo:392,396`).
- `hir.milo` + `lower.milo` (~1,000 lines) are **dead code**: scaffolded but
  never imported; codegen consumes the AST directly.
- TS oracle sizes: checker.ts 4,749 / codegen.ts 7,379 / total core ~15.4K
  lines. milo0's checker is a real port; its codegen is ~1,400 lines vs the
  TS 7,400 — the gap is mostly language *breadth*, which bootstrap does not
  fully need (see below).

### The two goals, in order

1. **Bootstrap** — milo-self compiles `src-milo/` itself and converges.
   Requires only the language subset milo0 is *written in*: Vec (incl.
   nested `Vec<Heap<Expr>>`), HashMap<string,V>, Heap-based recursive enums,
   payload enums + match, Option/Result with `!`/`?`, for-in, if-let,
   strings, structs, impl blocks. **Not required:** closures, user-defined
   generic fns/structs, traits beyond `impl Clone for X`, threads, green
   runtime. Do not build what bootstrap doesn't need.
2. **Parity** — milo-self passes the fixture suite (`tests/fixtures/`,
   `tests/errors/`). Full language. Comes after bootstrap; tracked by
   ratchet, may ship incomplete with an explicit exclusion list.

## Working Agreement (mandatory for the implementing agent)

- **Oracle**: the TS compiler (`src/*.ts`) is ground truth. Never change TS
  compiler behavior and milo0 behavior in the same commit. If the oracle
  itself is wrong, stop and flag it.
- **Ratchet**: `tests/selfhost-manifest.txt` lists fixtures milo-self must
  pass. Every commit must keep the manifest green; grow it, never shrink it
  (a temporary shrink requires a `# SHRUNK: <reason>` comment line and a plan
  to restore).
- **Commit cadence**: one green milestone (or sub-task) per commit, direct to
  main, one-line lowercase message. Run `bun test tests/selfhost.test.ts`
  before every commit; run the full `bun test` before ending a session.
- **When stuck >2 sessions on one task**: don't grind. Options in order:
  (a) shrink the repro with `emit-ir` diffing, (b) extract the failing
  pattern into a new fixture and fix the milo0 phase it exposes,
  (c) mark deferred in this doc with the repro path, move on.
- **Debugging playbook**: crash → `lldb -b -o run -o bt ./milo-self <cmd>`;
  wrong output → `diff <(bun run src/main.ts emit-ir f.milo) <(./milo-self
  emit-ir f.milo)`; regression → `git log --oneline -- src-milo/` and bisect
  by rebuilding milo-self at each candidate commit.
- Known runtime gotcha already fixed in TS codegen: allocas are hoisted to
  the entry block (loop-body allocas leak stack). milo0's codegen must do the
  same from day one (`codegen/emit.milo` — see `hoistAllocas` in
  `src/codegen.ts` for the invariant and `tests/allocaHoist.test.ts`).

## Milestones

### M0 — Differential harness (do this first, nothing else until green)

The root cause of today's silent breakage. Build the safety net before
touching src-milo.

- `scripts/selfhost.sh`: builds milo-self via the TS compiler into
  `.selfhost/milo-self`, exits nonzero on failure.
- `tests/selfhost.test.ts` (bun test, mirrors `tests/run.test.ts`):
  1. build milo-self;
  2. smoke: `milo-self check` + `run` on `fn main(): i32 { return 0 }`;
  3. for each fixture in `tests/selfhost-manifest.txt`: compile with
     milo-self, execute, compare stdout against the fixture's `// @expect:`
     lines (same parser as run.test.ts — factor it out, don't duplicate);
  4. report manifest coverage count.
- Seed the manifest with whatever passes today (likely zero — that's fine;
  the harness must exist and run in CI regardless).
- Wire into CI next to the existing test job.

**Accept**: `bun test tests/selfhost.test.ts` runs, builds milo-self, and
reports manifest status. Committed and in CI.

### M1 — Fix the crash

`./milo-self check min.milo` currently dies on the most trivial input, so the
fault is in startup or the shared front path (readFile → tokenize → parse →
newChecker). Bisect src-milo history (c7ef5ea vs its parent 6e987e7) by
rebuilding milo-self at each; lldb the winner. Suspect the copy-back /
deep-clone rework: hand-written `impl Clone` helpers on recursive
`Heap<T>` enums are exactly where a double-free or infinite clone loop would
live. If the bug turns out to be a *TS codegen* bug miscompiling valid milo0
code, extract a minimal fixture, fix the TS compiler first (separate commit),
then return.

**Accept**: smoke test in M0 green (`check` exit 0, `run` of return-0 works).
Seed manifest with all fixtures that pass; expect at least `hello`, `fib`,
`fizzbuzz` (stage-0 claims).

### M2 — Retire the dead HIR path (decision, then mechanical)

Decision (made here, don't relitigate): **bootstrap on the AST-directed
codegen**. The HIR port (`hir.milo`, `lower.milo`, ~1,000 lines) stays
unwired; move both files to `src-milo/attic/` with a header comment pointing
at this section. Rationale: the live pipeline works end-to-end for stage-0
programs, HIR adds a whole extra phase to debug through, and nothing about
bootstrap requires typed IR. Revisit HIR after F-convergence if checker-info
plumbing into codegen becomes painful (the TS compiler does AST+CheckResult →
HIR → IR; milo0's codegen re-deriving types from the AST is the known cost of
this shortcut — pay it until it actually hurts).

**Accept**: attic move committed, milo-self still builds, manifest unchanged.

### M3 — Close the codegen gaps (bootstrap subset)

Order chosen so each step unlocks fixtures for the ratchet. For each: port
the corresponding TS codegen logic (reference points below), add/enable
fixtures, grow the manifest.

- M3a `for i in A..B` and `for x in vec` — `codegen/stmt.milo:237` TODO;
  TS reference: `src/codegen.ts` ForIn cases (range at ~1448, vec/string
  iteration nearby). Range first (milo0 uses it since fbc44f3), vec second.
- M3b `if let` — `codegen/stmt.milo:267`; TS reference: IfLet lowering
  (match-with-one-arm desugar is acceptable if simpler).
- M3c `!` unwrap and `??` default — `codegen/expr.milo:392`; panic path
  must print the same "unwrap on None/Err" message shape as TS.
- M3d `?` propagate — `codegen/expr.milo:396`; requires the enclosing
  function's Result type from the checker — plumb via the checker tables
  (this is the first place M2's shortcut costs; if it takes >2 sessions,
  reconsider a minimal HIR for just this).
- M3e index assignment `v[i] = x` — `codegen/stmt.milo:33`.
- M3f sweep: grep src-milo for every construct it uses
  (`rg 'for |if let |[!?]\.|\?\?' src-milo --type-add 'milo:*.milo'` plus a
  read of each file's imports) and fixture-test each against milo-self.
  Anything unsupported gets a task appended here.

**Accept** per sub-task: named fixtures added to manifest and green.
**Accept** for M3 overall: every syntactic construct used by src-milo itself
has a green fixture in the manifest.

### M4 — Self-compile ratchet

File-by-file: `milo-self build` each src-milo file's standalone test driver,
starting with the leaves (tokens → lexer via `lexTest.milo` → ast → parser →
resolver → checker → codegen → main). For each file that fails, minimize the
failing construct into a fixture, fix, ratchet. Two known hard spots:

- Hand-written `impl Clone` deep-clones of recursive Heap enums — heavy
  recursion + drop interaction; if milo-self miscompiles drops here, isolate
  with tiny recursive-enum fixtures before debugging in the large.
- HashMap<string, V> in `checker/mono.milo` — milo-self's codegen must
  support the built-in HashMap fully (insert/get/iterate). Escape hatch if
  blocked: swap mono tables to sorted Vec + binary search (localized change).

**Accept**: `.selfhost/milo-self build src-milo/main.milo -o milo-self2`
succeeds and `milo-self2` passes the M0 smoke test.

### M5 — Bootstrap convergence

- `milo-self2 build src-milo/main.milo -o milo-self3`.
- `milo-self3` must be functionally identical to `milo-self2`: same manifest
  results, and `diff <(milo-self2 emit-ir f) <(milo-self3 emit-ir f)` empty
  for every manifest fixture (IR text equality is the convergence test —
  stronger and cheaper than binary identity, which clang timestamps break).
- Add the three-stage bootstrap as a CI job (allowed to be slow; nightly ok).

**Accept**: convergence green in CI. **This is the credibility milestone —
announce it in the README with the benchmark table.**

### M6 — Fixture parity (post-bootstrap, incremental forever)

Grow the manifest toward the full `tests/fixtures/` set (426 files). Track
the exclusion list explicitly at the bottom of this doc with reasons
(feature-gap vs bug vs deliberate-defer: closures, user generics, traits,
threads/green-runtime are the expected big remaining gaps). `tests/errors/`
parity (diagnostics) comes last — error-message equality is a polish task,
not a bootstrap requirement; parser still panics on mismatch
(`parser.milo:53`) and fixing that belongs here.

### M7 — (deferred, do not start) Retire TS

Unchanged from v1: dual-run CI diffing, LSP/formatter story, drop bun
requirement. Requires M6 substantially done. Not part of this plan's scope.

## Philosophy (unchanged from v1)

Self-hosting is a credibility milestone, not the product. If any milestone
stalls >2 weeks of active work, stop and reassess: skip the blocker, shrink
scope (a converging bootstrap on the milo0 subset is worth shipping even if
fixture parity never reaches 100%), or pause the track. Each milestone is
independently valuable. The worst outcome is months of compiler plumbing
while the language stagnates.

## Progress

| Milestone | Status | Date |
|---|---|---|
| M0 harness | not started | |
| M1 fix crash | not started (repro: `./milo-self check` on any file) | |
| M2 attic HIR | not started | |
| M3 codegen gaps | not started | |
| M4 self-compile | not started | |
| M5 convergence | not started | |
| M6 parity | not started | |

### Exclusion list (fixtures milo-self is not expected to pass yet)

(populate at M0 seed time)
