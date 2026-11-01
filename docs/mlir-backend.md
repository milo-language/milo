<!-- doc-meta
system: mlir-backend-plan
purpose: plan for replacing the LLVM-text codegen with HIR -> milo MLIR dialect -> LLVM, one function at a time behind MILO_MLIR=1
key-files: mlir/Milo.td, mlir/Scalar.cpp, src/emit-mlir.ts, src/mlir-backend.ts, scripts/mlir-same.ts, docs/collections-in-std.md
update-when: a milestone lands, the coexistence scheme or the gates change
last-verified: 2026-11-01 (M1 scalar functions in; shape rewritten for the high-level dialect)
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
    -> milo-opt (C++, mlir/): verify -> [desugar, drop elaboration: later]
       -> milo-lower-structured-cf -> convert-milo-to-llvm -> mem2reg, canonicalize
    -> LLVM IR, spliced into the legacy module (src/mlir-backend.ts) -> clang
```

- **Everything after the checker moves into MLIR**, JSIR/ClangIR style. The goal is to
  delete `src/lower.ts`, `src/hir.ts`, `src/codegen*.ts`, `src/ir.ts` and `src/mir*.ts`
  (about 19.5k lines). The TypeScript side becomes a thin printer of a **high-level `milo`
  dialect that mirrors the language**; every transformation is a C++ pass.
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
- **Leaks and ASan** from M4 on: no new findings under `MILO_MLIR=1`.
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
