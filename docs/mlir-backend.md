<!-- doc-meta
system: mlir-backend-plan
purpose: plan for replacing the LLVM-text codegen with HIR -> milo MLIR dialect -> LLVM, one function at a time behind MILO_MLIR=1
key-files: mlir/Milo.td, mlir/Scalar.cpp, mlir/Drops.cpp, src/emit-mlir.ts, src/mlir-backend.ts, scripts/mlir-same.ts, docs/collections-in-std.md
update-when: a milestone lands, the coexistence scheme or the gates change
last-verified: 2026-11-01 (third batch: main, print, aggregates, drop elaboration)
-->

# MLIR backend

Decided 2026-11-01: the backend moves to MLIR, committed rather than contingent. The
prototype (`mlir/README.md`) showed why: today's codegen cannot tell LLVM two facts Milo
knows (an element store never changes a Vec header; a panic is recoverable, so checks need
versioning, not hoisting), and the dialect expresses both, so axpy ran 2.9x faster.

## Shape

```
Source -> Lexer -> Parser -> Resolver -> Checker -> HIR  (TypeScript)
HIR -> high-level milo dialect (src/emit-mlir.ts: a printer, textual MLIR)
    -> milo-opt (C++, mlir/): verify -> milo-scope-drops -> expand-index, raise-to-scf
       -> milo-lower-structured-cf -> milo-elaborate-drops -> loop passes
       -> convert-milo-to-llvm -> mem2reg, canonicalize -> LLVM IR (--emit-llvmir)
    -> spliced into the legacy module (src/mlir-backend.ts) -> clang
```

- **Everything after the checker moves into MLIR**, JSIR/ClangIR style. The goal is to
  delete `src/lower.ts`, `src/hir.ts`, `src/codegen*.ts` and `src/ir.ts`. The TypeScript MIR
  (`src/mir*.ts`, `src/codegen-mir.ts`, `MILO_MIR`) went first, once MLIR took more function
  instances than MIR lowered without fallback (69078 against 61668 over the fixtures).
  The TypeScript side becomes a thin printer of a **high-level `milo` dialect that mirrors
  the language**; every transformation is a C++ pass.
- **Source-level ops** (`mlir/Milo.td`): structured control flow as region ops
  (`milo.if`, `milo.while`, `milo.loop` with `milo.break`/`milo.continue`/`milo.return`),
  mutable locals as `milo.var` slots with `milo.load`/`milo.store`, Milo's checked
  arithmetic as one op per operator carrying its trap (`wrapping` selects @wrapping), casts
  as `milo.cast`. Every op has a verifier: catching an emitter bug at the IR boundary is
  the point of the dialect. Models: ClangIR (`cir.if`, `cir.while`, `cir.break`, the
  `cir.alloca` slot model; llvm-project `clang/include/clang/CIR/Dialect/IR/CIROps.td`),
  JSIR (github.com/google/jsir: a JS AST mirrored as ops with regions) and Mojo's `lit`
  dialect (open source since Aug 2026; `Mojo/docs/compiler/MojoCompilerWalkthrough.md`:
  the parser emits `lit.fn`, `lit.var.decl`, `lit.ref.load/store`, control flow as
  `hlcf`/`lit.loop` region ops, and the LowerSemanticCF pass turns them into terminators,
  then CheckLifetimes and ElaborateGenerators run as passes; Milo keeps borrow checking
  and monomorphization in the TS checker for now).
- **The emitter reads HIR today**, and later reads the checker's output directly, once the
  desugaring `src/lower.ts` does moves into passes. The legacy backend is frozen; the
  default flips when coverage allows.
- **Analyses as MLIR passes**: drop elaboration (which drops run, where drop flags are
  needed) is a dataflow pass on the dialect, using MLIR's dataflow framework rather than a
  hand-written analysis.
- **Textual MLIR first.** The emitter prints MLIR text and `milo-opt` runs as a
  subprocess. If compile time demands it, switch to the MLIR C API over `bun:ffi`; the
  emitter's output does not change.

## Coexistence: one function at a time

A function compiles through the MLIR path when every HIR node in it is supported (one
predicate, `mlirSupports(fn)` in `src/emit-mlir.ts`), otherwise through the legacy
codegen. The MLIR function's LLVM body replaces the legacy body textually inside the one
module (`src/mlir-backend.ts`), under the legacy `define` line, so linkage, attributes and
the ABI are the legacy ones by construction. Not llvm-link: legacy non-exported fns are
`internal`, and internal symbols do not resolve across modules. Legacy codegen still
generates the replaced body, because its module-wide noalias dataflow reads every body. `MILO_MLIR=1` turns the path on; the coverage number (MLIR functions / all
function instances over the corpus) is printed by the gate and must only go up. When it
reaches 100% the default flips, then the legacy codegen is deleted.

## Milestones

| | Covers | Gate adds |
|---|---|---|
| M1 | scalar functions: ints, floats, bool, Milo's arithmetic traps (overflow, div by zero, shifts) with identical messages and lines, if/while/loop/break/continue/return, direct calls | coexistence and linking; compile-time number vs legacy |
| M2 | Vec access and bounds checks (`milo.vec.*`, `milo.bounds_check`), the versioning pass from the prototype | benchmarks: axpy and friends |
| M3 | strings, structs, enums, Option/Result | |
| M4 | owned values, moves, drops: drop elaboration pass | leak and ASan sweep under MILO_MLIR=1 |
| M5 | closures, interfaces, match | |
| M6 | tasks, contracts, globals, debug info (DWARF via MLIR locations) | lldb smoke test |
| M7 | default on; delete legacy codegen | |

**M1 progress (2026-11-01).** In: functions whose params, result and locals are ints of
any width (no declared range), f32/f64 or bool; literals, `let`/`var`/assign, every
arithmetic, bitwise, comparison and logical operator, unary `- ! ~`, scalar casts,
if/else, while, `while true` (`milo.loop`), `for i in a..b` (`milo.for`), break, continue,
return, and direct calls to any Milo or extern fn with scalar args. Traps match legacy byte
for byte: overflow (`__milo_overflow_fail`, file and line), division by zero, MIN / -1,
shift range, @wrapping and `--no-overflow-checks`, float to int saturation, NaN and -0.
Out, staying legacy: `main`, by-ref params (the largest reason by far), every non-scalar
type, globals, contracts when contract checks are on (-O0), replay-engine fns, if-expressions,
matches, builtins (print and friends), and a `for` whose bounds have another type than its
variable. `-g` builds work; MLIR functions carry no DWARF yet. Numbers: `bun test
tests/run.test.ts` under `MILO_MLIR=1` is 1797 pass, 0 fail, with 51234 of 262577 function
instances (19.5%) through MLIR; `scripts/mlir-same.ts` build time is 12 to 29% more on the
slices measured (two extra subprocesses per build, and the legacy body is still generated).

**Since M1 (2026-11-01).** Legacy codegen now emits only a stub for a function MLIR takes
(its `define` line and one dead call per callee, which is what the noalias analysis reads;
a function with a raw pointer keeps its legacy body for that analysis). The dialect gained
by-ref scalar params as second-class `!milo.ref` values (`milo-verify` rejects one that
outlives its call; `milo.check_unaliased` is legacy's runtime `&mut` aliasing guard),
by-ref params of other types that the body never names, raw pointers (`!milo.ptr`,
`milo.ptr.load/store`, pointer casts and compares), replay-engine functions
(`milo.replay.enter/exit`), and the first of M2: `&Vec<T>`/`&mut Vec<T>` params of scalars
(`milo.index`, `milo.index.store`, `milo.len`; `milo-expand-index` lowers them to the
prototype's `vec.len`/`bounds_check`/`vec.load`). `milo-raise-to-scf` moves loops without
early exits to scf.for, where `milo-hoist-vec-reads` and `milo-version-bounds-checks`
run: axpy compiled from Milo source under `MILO_MLIR=1` vectorizes (0.095 ns/elem against
0.278 for legacy, `mlir/run.sh`), grid stays at parity. Corpus under `MILO_MLIR=1` with
the Vec ops in: 1805 pass, 0 fail, 71962 of 263941 instances (27.3%). Still legacy:
`main` and the print builtins, by-value non-scalar params (they need drops, M4), strings,
structs, enums.

**Third batch (2026-11-01): main, print, aggregates, drop elaboration.**

- *main and print.* `main` goes through MLIR unless a green-task wrapper owns it
  (`mlirMainOk`): it is `i32 @main(i32, ptr)`, and the splice moves legacy's prologue
  (argc/argv globals, stdout buffering, global init) to the top of the MLIR entry block. A
  main with a raw pointer stays legacy (its body would be kept for the noalias analysis, and
  then there is no stub to find the prologue in). `milo.print` (`stderr` for eprint) takes
  every part; `print($"...")` is `print(format(parts))` in HIR and prints the parts. It
  lowers to one call of a legacy function generated for exactly that sequence of part
  types (codegen `mlirHelper`/`mlirPrintHelper`, named by `typeKey`), so the formatting is
  legacy's by construction instead of a second copy of it in C++.
- *Aggregates.* `!milo.struct<"Name", fields...>` and `!milo.enum<"Name", size, align,
  [tag: (T at offset, ...)]>` lower to LLVM's identified structs of legacy's names, so a
  spliced body uses the module's own `%Name`. The enum spells out legacy's `EnumLayout`
  (codegen `mlirEnumLayout`): nothing in C++ recomputes it, the tag and payload go through
  an entry-block slot at those byte offsets as in `enumFieldPtr`. Niche-packed enums
  (ranged ints) and aggregates of 128 bytes or more (`isBigAgg`) stay legacy. Ops:
  `struct.new/get`, `field_ref` (a field's place, for loads, stores and by-ref args),
  `enum.new/tag/payload`, and `milo.match`: a region per arm, an enum arm's payload as its
  entry block's arguments (read at the arm's entry by milo-lower-structured-cf, which
  switches on the tag), literal cases on ints and bools, `default` for `_`. If-expressions
  are `milo.if` with results. `&mut` match subjects, nested patterns and float or string
  literal patterns stay legacy.
- *Owned values (M4 foundation).* `!milo.string` and `!milo.vecval<T>` (Vec of scalars by
  value; its place is the M2 `!milo.vec<T>`, via `vec.place`) live only in `milo.var
  owned` slots, listed by the `milo.scope` that owns them. The emitter states facts:
  `milo.store` (init or overwrite), `milo.move` (the checker's `isMove` last use),
  `milo.load` (a view, for borrows), `string.share` (HIR StringClone). milo-scope-drops
  puts a `milo.drop` at every scope exit (end, break, continue, return) and before every
  store over a value with drop glue, then inlines the scopes. milo-elaborate-drops runs
  MLIR's dense forward dataflow (DeadCodeAnalysis + a definitely/maybe-init lattice per
  owned slot) over the CFG: a drop of a slot empty on every path goes, one full on every
  path stays, the rest get the slot's drop flag (`milo.drop %s if %flag`, the flag kept
  in step at every store, move and drop), and a read of a slot that may be empty is a
  compile error. A drop calls `milo.drop.<key>(ptr)`, legacy's drop glue
  (`mlirDropHelper`); string share calls a legacy-generated function too. Owned
  temporaries in a borrow position (print, `&T` args, len) go into a slot of the
  innermost block. Structs and enums holding strings or Vecs are not taken yet.
- *After step 3, by coverage.* std's Vec methods (written in Milo since collections-in-std)
  are the most common functions: raw-pointer places (`milo.ptr.elem`, `milo.ptr.field`,
  read and written with ptr.load/store so a header write through one is never mistaken
  for slot traffic), `milo.addr` (addrOf), `milo.vec.data` (ptr()), wrapping arithmetic,
  sizeOf, and `_vecGrowBuf` through a legacy helper. Vec places take any element type;
  only indexing needs scalars (legacy clones an owning element). `milo.string.byte` is
  `s[i]` with legacy's bounds panic. Structs and enums holding strings and Vecs are owned
  values (needsDrop is structural); still legacy: types with a user `Drop` (its timing is
  observable, and temporaries die at block end here, at statement end there), moving an
  owning field out, matching an owning enum by value, struct update of an owning struct.
  String `== != < <= > >= +`, substr and push call legacy helpers; the ones that panic are
  generated per call site, with the call's span, so the panic names the same line.
- *Gates.* Programs `print`, `aggregates`, `owned`, `stdvec`, `owning-aggregates`,
  `strings`, `trap-string-index-oob`, `trap-substr-oob` under `mlir/test/programs`; FileCheck
  `print.mlir`, `aggregates.mlir`, `drops.mlir`, verifier cases in `verify.mlir`. Planted
  bugs: string literal length - 1 turned `print` red; payload read at field 0's offset
  turned `aggregates` red (`area(Rect(2, 3))` printed 4); making maybe-init drops
  unconditional left `mlir-same` green but ASan reported a heap-use-after-free in
  `owned`; erasing every drop left 23 more live heap blocks at exit; both turn `--owned` red.
  Later: `ptr.elem` at index 0 turned `stdvec` and `owned` red; no drop before a store
  through a field place left one more live block in `owning-aggregates` (`--owned` red);
  swapped string operands turned `strings` red; a substr helper without the call's span
  turned `trap-substr-oob` red (stderr). FileCheck adds `pointers.mlir`.
- *Leaks on this machine.* `leaks -atExit` (scripts/leak-check.ts) and lldb never get the
  task port here and hang, on legacy binaries too: the lldb replay test ("a breakpoint on
  miloReplayStop stops at the record") fails the same way on legacy, so it is the
  machine. ASan's symbolizer (atos) hangs the same way on a report; run with
  `ASAN_OPTIONS=symbolize=0`. The leak check used instead is `mlir-same --owned` (Gates).
- *One process.* `milo-opt --emit-llvmir <passes>` runs the pipeline and prints LLVM IR
  (byte-identical to piping into mlir-translate); the milo-opt stage went from about 40
  to 26 ms on the `owned` program.

Collections-in-std (`docs/collections-in-std.md`) runs alongside: every method body that
moves into std becomes ordinary Milo, which this backend handles without special cases.

### After M7: modularity

Once every function goes through the dialect, std can write `milo` and upstream ops
inline (std-only or `unsafe`-gated, the way Mojo's std spells `__mlir_op.`). Then Vec,
HashMap and string become plain std structs whose methods are Milo plus a few inline ops,
with no type tags in the checker. The checker shrinks to the core rules: ownership,
second-class references, generics, traits. Collection-specific rules (a Vec element store
never moves the header, bounds checks are panic points) become attributes on those std
types, checked and exploited by generic passes rather than by special cases. SIMD and GPU
become opt-in std modules over upstream dialects (`vector`, `gpu`), not compiler features.

### Candidate: verification from the compiled IR

Contracts (`requires`, `ensures`, loop invariants) lower to the upstream `smt` dialect
from the same milo IR that is compiled, so what is proven is what runs, rather than a
separate model of the source (`src/verify.ts` today).

## Gates (every milestone, every commit)

- **Corpus diff**: `bun test tests/run.test.ts` with `MILO_MLIR=1` passes exactly as without
  it. `bun scripts/mlir-same.ts` builds every fixture both ways and diffs stdout, stderr
  and exit status, and prints coverage and build time; it fails when nothing went through
  MLIR. `--programs` runs only `mlir/test/programs/` (scalar programs and one per trap,
  seconds), which `mlir/run.sh` runs too. A planted bug in an MLIR lowering must turn
  fixtures red: on M1, `slt` -> `sle` turned base32Totp and binaryVarint red (and the
  scalar program); swapping the panic branch turned 11 of the 12 trap programs red
  (loop-overflow then panics on the first multiply instead of the overflowing one, with
  the same message and line) and the scalar program too.
- **FileCheck tests** per pass and per lowering, in `mlir/test/`, each run by its own
  `RUN:` line from `mlir/run.sh`; `verify.mlir` covers the op verifiers.
- **Ownership** from M4 on, required for any commit touching ownership lowering (owned
  slots, scopes, moves, drops, drop elaboration): `bun scripts/mlir-same.ts --programs
  --owned` before committing, the full corpus with `--owned` in the background. For every
  program MLIR took part of, live heap blocks at exit must equal legacy's
  (`scripts/livecount.c`, a malloc/free counter injected with DYLD_INSERT_LIBRARIES; on
  Linux LeakSanitizer covers it) and the MLIR binary must run clean under ASan
  (`ASAN_OPTIONS=symbolize=0`: symbolizing needs the task port, which hangs here). The
  output diff cannot gate this: making maybe-init drops unconditional left it green
  while ASan reported a heap-use-after-free (`--owned` red), and erasing every drop
  left 202 live blocks against legacy's 179 (`--owned` red).
- **Compile time** of the corpus, legacy vs MLIR path, recorded from M1. A regression is a
  problem to fix (in-process C API, caching, parallel CGUs), not a reason to stop.
- **Coverage** only goes up.

## Toolchain

`mlir/` builds `milo-opt` against an installed MLIR (Homebrew LLVM 23.1.3 today) with one
CMake configure: `sh mlir/build.sh`. A `MILO_MLIR=1` build compiles the whole module with
the clang of that same LLVM (`/opt/homebrew/opt/llvm/bin/clang`), never Apple's: LLVM 23 IR
fed to clang 21 is version skew (it already rejects LLVM 23's float constant syntax), and
a `MILO_CC` of another version is an error. MLIR's C++
API changes every release, so the LLVM version is pinned and bumped on purpose.
`MILO_MLIR=1` without a built `milo-opt` is an error naming the build command, never a
silent fallback.
