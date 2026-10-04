<!-- doc-meta
system: fast-iteration-plan
purpose: cut the edit-to-running loop to well under a second via measurement, finer object caching, mixed opt levels, a daemon, a HIR interpreter, hot patching and a cheap dev backend
key-files: src/cgu.ts, src/objcache.ts, src/main.ts, scripts/edit-loop.ts
update-when: a step ships or is abandoned, or the edit-loop numbers move
last-verified: 2026-10-03
-->

# Fast iteration: edit-to-running in well under a second

Goal: the edit loop (change a line, see it run) on a large program costs a fraction of a
second, without giving up native semantics or checked safety. Rust pays LLVM for every
changed unit; we attack both factors of `work redone per edit × cost per unit of work`.

Every step ships behind a measured number from `scripts/edit-loop.ts` (step 0). A step
that does not move the number does not land.

## State at start (2026-10-03)

Already shipped (see `milo-first-inner-loop.md`):
- `src/cgu.ts`: parallel codegen units, auto above 20k IR lines, module-grouped packing.
- `src/objcache.ts`: SHA-256 content-hashed object cache per unit; sticky placement so
  an edit leaves untouched units byte-identical and served from cache.
- `--fast` (-O0 + wrapping arithmetic).

Last measured (2026-07, milojs ~7.5k LOC): frontend 0.68s, clang -O2 2.7-4.2s. No
per-phase timing exists in `src/`, so no current breakdown.

Known gaps in what shipped: cache granularity is a whole unit (an edit recompiles 1/N
of the program at -O2), every build is a fresh Bun process re-parsing and re-checking
std, and the link always runs.

## Steps (ordered by leverage per unit of work)

0. **Measure.** `MILO_TIMING=1` per-phase breakdown (lex/parse, resolve, check, lower,
   codegen, split, clang per unit, link). `scripts/edit-loop.ts`: for a fixed set of
   programs, time cold build, unchanged rebuild, one-line edit in a user fn, and report
   the table. This is the number every later step must move.
1. **Finer cache granularity.** Edit invalidates one unit; make the invalidated unit
   small. Options: more, smaller units for dev builds (cache hit rate up, link and
   promotion cost up), or isolate the edited module into its own unit. Measure first.
2. **Mixed opt levels.** std instances at -O2 (cached, rarely change), user code at
   -O0. Keeps hot std loops fast, so most of `--fast`'s runtime penalty disappears.
   Needs: the unit packer separates std-origin functions from user functions.
3. **Compiler daemon.** `milo daemon`: long-lived process holding Bun's warm JIT,
   parsed+checked std, and (later) the in-memory object cache. Client is a thin CLI
   that falls back to in-process when no daemon runs. Invalidation by content hash,
   never mtime. Only worth it once 1-2 leave the frontend as the dominant cost.
4. **HIR interpreter dev tier.** `milo run --interp`: execute typed HIR directly, no
   LLVM. Instant start, 10-50x slower execution: for tests and agent loops, not
   emulators. Doubles as a differential oracle (interp vs native output on every
   fixture). FFI via a libffi-style bridge or reject `extern` initially.
5. **Hot patching.** Daemon recompiles one function at -O0 and swaps it into the
   running process via a debug-build function pointer table. Struct layout change =
   restart. Target: games and emulators keep state across edits.
6. **Cheap dev backend.** Copy-and-patch stencils (CPython 3.13 JIT), QBE, or a
   single-pass LLVM-IR backend (TPDE). Biggest lever on per-unit cost, biggest effort.
   Revisit only if 1-3 leave clang -O0 as the floor.
7. **Less IR.** Share generic instances and drop glue with identical layout
   (polymorphization). Cuts work for every backend.
8. **Check-only loop.** Measure what fraction of agent iterations end in a type error;
   if high, the LSP/daemon diagnostics path matters more than codegen speed.

## Invariants

- Fail closed: any cache/daemon/split failure falls back to the plain single-module
  in-process build. A speed path may cost time, never correctness.
- Cache keys are content hashes of everything that shapes the output.
- Dev-tier semantics match native: overflow traps, bounds checks, drop order. The
  interpreter is gated by a differential sweep over all fixtures.
- Release builds (`--release`, `-g`) are untouched by steps 1-3.

## Progress log

- 2026-10-03: plan written.
- 2026-10-03: step 0 shipped (`MILO_TIMING=1`, `scripts/edit-loop.ts`). Baseline,
  redline (8k-line game) one-line edit at -O2, warm cache: **1.11s**. check 0.28,
  split 0.21, verify c decls 0.17, clang 0.18 (1/8 units), codegen 0.08, resolve 0.06,
  link 0.04, Bun startup 0.03. Unchanged rebuild still 0.93s with zero clang.
  Conclusion: clang is 16%, not the bottleneck at this size. Reorder: cache the c-decl
  check (fixed cost every build), make `split` cheap (TS regex re-parse of the whole IR
  even on full cache hits; codegen already knows function boundaries), then the daemon
  for check/resolve/codegen. Step 1 (finer units) is worth at most ~0.18s here.
  Also fixed: `MILO_OBJ_CACHE=0` silently skipped every split compile and fell back to
  one serial module (jq cold 0.89s -> 0.57s).
- 2026-10-03: c-decl check cached (header content hashes from clang's depfile): 0.20 -> 0.03s
  warm. Split 0.24 -> 0.03s (a regex lookbehind knocked JSC off its regex JIT; output
  byte-identical across 1490 fixture splits). Redline one-line edit 1.17 -> 0.96s on a
  loaded machine; frontend is now ~60%.
  Warm-JIT experiment (frontend 8x in one process, redline): 566ms cold -> ~350ms warm
  (check 360 -> 230, resolve 77 -> 50, codegen 100 -> 60). So a daemon buys ~0.2s from the
  JIT alone, plus resolve's std re-parse if it caches ASTs by content hash. Check at
  ~230ms warm is real work: profile it for hot spots before building any incremental
  checking.
- 2026-10-03: frontend hot-spot pass (4 fixes, IR + diagnostics byte-identical on 1275
  files, full suite green). Main one: every statement rescanned every binding in scope,
  and the module scope holds every global (309 in redline); scans are now lazy/skipped.
  Redline in-process check 283 -> 102ms cold, 192 -> 46ms warm. Edit loop (quiet
  machine): one-line edit 0.77 -> **0.57s**, unchanged rebuild 0.59 -> 0.40s, frontend
  0.44 -> 0.25s. Profile now flat (nothing over 3.5%). Remaining cold frontend ~250ms vs
  ~130ms warm: the daemon (step 3) is next, worth ~0.12s JIT + ~20ms std re-lex/parse.
- 2026-10-03: hot unit (cgu.ts `HotState`). Functions whose IR changed since the last
  build go to an extra unit (cap: 64 fns, half a unit's share), so repeat edits recompile
  only it. Redline one-line edit 0.59 -> 0.50s (clang 0.18 -> 0.10, main alone is 0.09);
  java-dap 0.52 -> 0.40s (clang 0.15 -> 0.03). First edit on an empty cache compiles the
  old home too (2/9, in parallel, same 0.10s). Runtime: json/sort benchmarks with the hot
  function split out are within noise. Also fixed: a global naming a function (trait
  itables) was not counted as a reference, so 11 fixtures' splits fell back to one module.
