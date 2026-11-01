<!-- doc-meta
system: mlir-backend-plan
purpose: plan for replacing the LLVM-text codegen with HIR -> milo MLIR dialect -> LLVM, one function at a time behind MILO_MLIR=1
key-files: mlir/, src/codegen.ts, src/hir.ts, src/main.ts, docs/collections-in-std.md
update-when: a milestone lands, the coexistence scheme or the gates change
last-verified: 2026-11-01 (plan written; prototype in mlir/ only)
-->

# MLIR backend

Decided 2026-11-01: the backend moves to MLIR, committed rather than contingent. The
prototype (`mlir/README.md`) showed why: today's codegen cannot tell LLVM two facts Milo
knows (an element store never changes a Vec header; a panic is recoverable, so checks need
versioning, not hoisting), and the dialect expresses both, so axpy ran 2.9x faster.

## Shape

```
Source -> Lexer -> Parser -> Resolver -> Checker -> HIR  (TypeScript, unchanged)
HIR -> milo dialect (TypeScript emitter, textual MLIR)
    -> milo-opt: milo passes + upstream passes (C++, mlir/)
    -> LLVM IR -> linked with the legacy module -> clang
```

- **HIR straight to the dialect**, the way ClangIR goes from the AST to `cir` and Flang
  from the parse tree to `fir`. There is no separate TypeScript mid-level IR: the dialect is
  the mid-level IR. The TypeScript MIR (`src/mir.ts`, `src/mir-build.ts`,
  `src/codegen-mir.ts`) retires once milestone 1 covers what it covered.
- **Milo semantics as ops**: Vec and HashMap access, bounds and overflow checks, moves and
  drops, closures, interfaces. Plain arithmetic and control flow use upstream `arith`, `scf`,
  `cf` and `func`.
- **Analyses as MLIR passes**: drop elaboration (which drops run, where drop flags are
  needed) is a dataflow pass on the dialect, using MLIR's dataflow framework rather than a
  hand-written analysis.
- **Textual MLIR first.** The emitter prints MLIR text and `milo-opt` runs as a
  subprocess. If compile time demands it, switch to the MLIR C API over `bun:ffi`; the
  emitter's output does not change.

## Coexistence: one function at a time

A function compiles through the MLIR path when every HIR node in it is supported (one
predicate, `mlirSupports(fn)`), otherwise through the legacy codegen. Both produce LLVM IR
with the same symbol names and calling convention, so the two modules link into one
program. `MILO_MLIR=1` turns the path on; the coverage number (MLIR functions / all
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

Collections-in-std (`docs/collections-in-std.md`) runs alongside: every method body that
moves into std becomes ordinary Milo, which this backend handles without special cases.

## Gates (every milestone, every commit)

- **Corpus diff**: `bun test tests/run.test.ts` with `MILO_MLIR=1` passes exactly as without
  it. A planted bug in an MLIR lowering must turn fixtures red.
- **FileCheck tests** per pass and per lowering, in `mlir/test/`.
- **Leaks and ASan** from M4 on: no new findings under `MILO_MLIR=1`.
- **Compile time** of the corpus, legacy vs MLIR path, recorded from M1. A regression is a
  problem to fix (in-process C API, caching, parallel CGUs), not a reason to stop.
- **Coverage** only goes up.

## Toolchain

`mlir/` builds `milo-opt` against an installed MLIR (Homebrew LLVM 23.1.3 today) with one
CMake configure. MLIR's C++ API changes every release, so the LLVM version is pinned and
bumped on purpose. `MILO_MLIR=1` without a built `milo-opt` is an error naming the build
command, never a silent fallback.
