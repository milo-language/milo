<!-- doc-meta
system: mlir-backend
purpose: design reference for the backend: HIR -> milo MLIR dialect -> LLVM, the only backend (the legacy LLVM-text codegen is deleted)
key-files: mlir/Milo.td, mlir/Scalar.cpp, mlir/Drops.cpp, mlir/Passes.cpp, mlir/Link.cpp, src/emit-mlir.ts, src/mlir-backend.ts, src/scaffold.ts, scripts/mlir-same.ts, docs/collections-in-std.md
update-when: the pass pipeline, the gates or the dialect's design rules change
last-verified: 2026-11-03 (scaffold moved into MLIR, codegen.ts deleted; pipeline checked against src/mlir-backend.ts)
-->

# MLIR backend

The backend is MLIR. The prototype (`mlir/README.md`) showed why: a text-IR codegen cannot
tell LLVM two facts Milo knows (an element store never changes a Vec header; a panic is
recoverable, so checks need versioning, not hoisting), and the dialect expresses both, so
axpy ran 2.9x faster.

## Shape

```
Source -> Lexer -> Parser -> Resolver -> Checker -> HIR  (TypeScript)
HIR -> high-level milo dialect (src/emit-mlir.ts: a printer, textual MLIR)
    -> milo-opt (C++, mlir/): the passes below
    -> LLVM IR (--emit-llvmir)
    -> the runtime sections linked in (mlir/Link.cpp) -> clang
```

- **The TypeScript side is a thin printer** of a high-level `milo` dialect that mirrors the
  language; every transformation is a C++ pass. The emitter reads HIR (`src/lower.ts`,
  `src/hir.ts`). Moving the desugaring in `src/lower.ts` into passes, so the emitter reads
  the checker's output directly, is future work.
- **Source-level ops** (`mlir/Milo.td`): structured control flow as region ops (`milo.if`,
  `milo.while`, `milo.loop` with `milo.break`/`milo.continue`/`milo.return`), mutable locals
  as `milo.var` slots with `milo.load`/`milo.store`, Milo's checked arithmetic as one op per
  operator carrying its trap (`wrapping` selects @wrapping), casts as `milo.cast`. Every op
  has a verifier: catching an emitter bug at the IR boundary is the point of the dialect.
  Models: ClangIR (`cir.if`, `cir.while`, the `cir.alloca` slot model), JSIR (a JS AST
  mirrored as ops with regions) and Mojo's `lit` dialect (region control flow lowered to
  terminators by a pass). Borrow checking and monomorphization stay in the TS checker.
- **Analyses are passes**: drop elaboration (which drops run, where drop flags are needed)
  is a dataflow pass on the dialect, using MLIR's dataflow framework.
- **Textual MLIR.** The emitter prints MLIR text and `milo-opt` runs as a subprocess. If
  compile time demands it, switch to the MLIR C API over `bun:ffi` or to bytecode; the
  emitter's output does not change.
- **One module.** Every function compiles through MLIR: `emitMlirFunction` in
  `src/emit-mlir.ts` throws `MlirUnsupported` for a construct the dialect does not cover,
  and the build fails naming the reason (no per-function fallback). The scaffold around the
  functions is MLIR too (see The module below).
- **Targets.** MLIR is on for every target (cross builds, Windows, wasm64, Cortex-M).
  milo-opt emits for the target: the module carries `llvm.target_triple` and
  `llvm.data_layout` (the layout clang uses for that triple, asked of milo-opt's own clang
  once per build); the runtime sections are linked with the module's triple and layout.
  Sizes come from the target layout, so 32-bit Cortex-M has 4-byte pointers.
  `bun scripts/mlir-cross.ts` is the gate for non-host targets.

## Passes

In `milo-opt` pipeline order (`MLIR_PIPELINE` in `src/mlir-backend.ts`). The passes under
`func.func(...)` see one function at a time, so MLIR's pass manager runs them in parallel.

1. `milo-verify` (`mlir/Scalar.cpp`): checks the rules of the source-level dialect that span ops.
2. `milo-append-in-place` (`mlir/Drops.cpp`): rewrites `s = s + x` on strings to an in-place
   append. It runs before scope-drops, whose drop of the old value would name the place and
   stop the rewrite.
3. `milo-scope-drops` (`mlir/Drops.cpp`): drops owned slots where control leaves their scope,
   and old values before stores, while scopes are still regions. Which drops run is decided later.
4. `milo-expand-index` (`mlir/Scalar.cpp`): lowers source-level Vec indexing to `len`,
   `bounds_check` and `vec.load`/`vec.store`.
5. `milo-raise-to-scf` (`mlir/Scalar.cpp`): raises `milo.for` loops without early exits (and
   their ifs) to `scf`, where the Vec passes work.
6. `milo-lower-structured-cf` (`mlir/Scalar.cpp`): lowers the remaining `milo.if`/`while`/`loop`/`for`
   and their jumps to `cf` branches, before any generic pass. Break, continue and return are
   not region-branch terminators, so CSE would otherwise reuse a load from before a
   `milo.while` inside its body.
7. `milo-elaborate-drops` (`mlir/Drops.cpp`): keeps, erases or flags each drop of an owned
   slot by whether it is initialized (dense dataflow over the CFG), before any generic pass
   can move a store or a drop.
8. `canonicalize`, with `SelectToExtUI` disabled: it would turn a select with Milo's si32 type
   into a signless-only op that fails to verify.
9. `milo-hoist-vec-reads` (`mlir/Passes.cpp`): hoists `vec.len` out of loops that never write a Vec header.
10. `loop-invariant-code-motion`.
11. `milo-version-bounds-checks` (`mlir/Passes.cpp`): runs a copy of a loop without bounds
    checks when one up-front range test proves every check passes, the original otherwise.
12. `cse`, `canonicalize`, `convert-scf-to-cf`.
13. `convert-milo-to-llvm` (`mlir/Passes.cpp`): lowers milo, func, arith and cf to the LLVM dialect.
14. `reconcile-unrealized-casts`, then `llvm.func(mem2reg, canonicalize)`.

`milo-expand-checks` (`mlir/Passes.cpp`: `bounds_check` to a compare and a call to the panic
routine) is defined and exercised by `mlir/run.sh`, but is not in the driver pipeline.

## Leverage

What the move buys after coverage is complete, in order of payoff. Each one is upstream
MLIR or LLVM code we reuse rather than write. Nothing here is claimed until it ships.

| Lever | Upstream piece | What Milo gets | Status |
|---|---|---|---|
| Cheaper safety | `IntegerRangeAnalysis`, dataflow framework | prove overflow and bounds checks dead and delete them; checked arithmetic costs less | partly: bounds-check versioning ships; the region ops describe their control flow (RegionBranchOpInterface, LoopLikeOpInterface) and milo.const/milo.cmp their ranges, so `--int-range-optimizations` proves ranges through them (`mlir/test/region-branch.mlir`); not in the pipeline |
| Correctness tooling | crash reproducers (`--mlir-pass-pipeline-crash-reproducer`), `mlir-reduce`, `--mlir-print-ir-after-all`, debug counters | a compiler crash becomes a one-file repro, reduced automatically; bisect a miscompile to one pass application | available, not wired into the driver |
| Compile time | multithreaded pass manager | function passes run in parallel for free; the fix for the current build-time regression | not measured |
| Contracts | `smt` dialect | `requires`/`ensures` checked by a solver from the same IR the compiler lowers | decided (see Verification from the compiled IR) |
| Loop optimization | `memref`, `affine`, `linalg`, `vector` | scalar Vec and array loops lower through `memref` (everything else stays milo to llvm), gaining tiling, fusion and vectorization of array and Vec loops, which hand-written IR never had | prototype only (axpy 2.9x) |
| Portable C | `emitc` | emit C source for targets with a C compiler but no good LLVM backend (odd MCUs, certified toolchains); an alternative path for Cortex-M | not started |
| Async | `async` dialect, LLVM coroutines | tasks lower through upstream coroutine passes instead of hand-built state machines | not started |
| Debug info | `Location` plus LLVM dialect debug attributes | DWARF follows every op through every pass | open (see Open items) |
| Caching | MLIR bytecode | stable serialized modules: incremental builds, prechecked packages | not started |
| Other clients | the dialect itself, C API | another frontend (a self-hosted Milo frontend, ChadScript) targets `milo` and inherits drops, checks and lowering | self-hosting plan |
| New targets | `gpu`, NVVM, ROCDL, SPIR-V | Milo kernels on GPUs, later | not planned |

## Next: modularity

Not built. Every function goes through the dialect, so std could write `milo` and upstream ops
inline (std-only or `unsafe`-gated, the way Mojo's std spells `__mlir_op.`). Then Vec,
HashMap and string become plain std structs whose methods are Milo plus a few inline ops,
with no type tags in the checker. The checker shrinks to the core rules: ownership,
second-class references, generics, traits. Collection-specific rules (a Vec element store
never moves the header, bounds checks are panic points) become attributes on those std
types, checked and exploited by generic passes rather than by special cases. SIMD and GPU
become opt-in std modules over upstream dialects (`vector`, `gpu`), not compiler features.
See `docs/collections-in-std.md`.

## Verification from the compiled IR

Decided, not built. Contracts (`requires`, `ensures`, loop invariants) lower to the
upstream `smt` dialect from the same milo IR that is compiled, so what is proven is what
runs, rather than a separate model of the source (`src/verify.ts` today). The `smt` ops
export through upstream's SMT-LIB exporter to z3, or to Milo's own QF_LIA solver
(`std/smt.milo`), which `src/prove-milo.ts` already drives from SMT-LIB text.

## Raising

Not built. Two raising-shaped rewrites need no dialect and are checker warnings with `milo fix`
fixes instead: `var-never-reassigned` (`var` to `let`) and `unwritten-mut-param` (`&mut T` to
`&T`, call sites included), both in `src/checker-mutability.ts`. `milo harden` is reserved for
rewrites that need facts only the dialect has (last-use clone to move, range-based `@wrapping`
removal, contract inference). Raising comes after the self-hosted frontend: the source-faithful top layer it
needs (comments, spelling, layout) is frontend work, so it is built once, in the Milo
frontend. JSIR's defining trait is that it round-trips: source goes up into the dialect,
passes transform it, and it prints back as source. Milo gets the same:

- The top layer stays source-faithful (for-in, `?`, interpolation kept as ops; desugaring is
  a pass), and the emitter reads the checker's output rather than desugared HIR.
- A dialect-to-Milo printer plus `milo fmt`; edits are minimal so comments survive.
- Proof gate per rewrite: the printed source re-parses to the identical top-layer dialect,
  and a pure refactor lowers to identical normalized IR.
- Rewrites: `var` to `let`; unwritten `&mut T` to `&T`; read-only owned private params to
  `&T`; last-use clone to move; dead `@wrapping`; index loops to for-in; match on Result to
  `?`; `isSome` plus unwrap to `if let`; contract inference; dead code. First proof of
  concept: `var` to `let` and `&mut` to `&`.

## The dialect as a product

Anything that emits valid milo dialect gets Milo's semantics and lowering; the first such
client is the self-hosted frontend. The reference is generated from `Milo.td`: every op,
type and attribute carries a summary and a description, and `sh mlir/build.sh` writes
[docs/dialect/milo.md](dialect/milo.md) with `mlir-tblgen -gen-dialect-doc` (never edited by
hand). Still needed: a `libMiloDialect` library and C API, and a versioned format (MLIR
bytecode dialect versioning). The verifiers are the contract a client codes against.

## Dialect hygiene

`bun scripts/dialect-hygiene.ts` (run by `mlir/run.sh`) reads `Milo.td` through
`llvm-tblgen --dump-json`, so class inheritance and trait lists are resolved by TableGen,
and fails when any op, type or attribute lacks a summary or a description, when an error
an op verifier in `Milo.cpp` can emit has no `expected-error` case (`--uncovered` lists them;
`verify.mlir` and `verify-ops.mlir` hold the cases), when
[docs/dialect/milo.md](dialect/milo.md) is not what `Milo.td` generates, or when a count drops
below `scripts/dialect-hygiene.baseline.json` (ops with verifiers, declared effects, Pure,
op interfaces, folders, canonicalizers, verify-diagnostics cases). `--ops` prints one row per
op; `--update` rewrites the baseline after a count went up.

Control flow: milo.if, milo.match and milo.scope yield to their parent, milo.while goes
cond to body or out, milo.for runs its body zero or more times, and milo.yield and
milo.condition are the region branch terminators. break, continue and return are not: they
leave any number of regions at once, which RegionBranchOpInterface cannot express. Sparse
analyses stay sound (no value travels along those jumps, and liveness is per block); dense
analyses would not, so none runs before `milo-lower-structured-cf`.

Symbols and calls: milo.closure is a SymbolUserOpInterface; milo.closure.call is a
CallOpInterface (indirect: the callee is the fn value), so the dataflow framework takes it
through its call path (`mlir/test/call-interface.mlir`). milo.global and milo.global.init
name a global the scaffold module defines, so the MLIR module holds no symbol to check. A
`milo.global.decl` symbol declared by `src/emit-mlir.ts` would fix that.

Folders (`mlir/test/fold.mlir`): checked arithmetic folds constant int operands only when the
result cannot trap, so a program still panics where Milo panics (a zero divisor never
folds, signed MIN / -1 only under `wrapping`). Bitwise ops, int compares, int casts,
struct.get of a struct.new, enum.tag of an enum.new and milo.if on a constant fold too.
Floats fold in LLVM. The dialect conversion folds as well, so these also run inside
`convert-milo-to-llvm`.

Round-trip: `mlir/run.sh` runs MlirOptMain's `--verify-roundtrip` (print in generic form and
as bytecode, parse back, print again, compare) over every test file of valid IR and over the
module the emitter prints for every `mlir/test/programs` program (`MILO_MLIR_DUMP`), so a
type printer and parser that disagree fail there before any frontend meets them.

## Design rule: data-oriented, no caches

Decided 2026-11-01. Everything written from here on (the emitter, passes, the self-hosted
frontend, std) answers these: flat arrays instead of hash tables; indices instead of
pointers, with hot data packed into the upper bits of the index; structure of arrays where
access is per field; small lists with inline capacity on the stack; bitsets, never arrays of
bools. No caches: a slow step is redesigned, not memoized, and existing caches go when their
code is touched. Concretely: per-type decisions are packed flag bits on an interned type id,
not sets keyed by type text (that keying already hid an ownership bug); the self-hosted
frontend keeps tokens, AST and HIR as flat arrays of u32 ids (the Zig and Carbon toolchain
layout); build time comes from removing the text round trip between emitter and milo-opt
(in-process, or MLIR bytecode) and from compiling std once as a library, not from a
per-function compile cache.

## Open items

- DWARF for MLIR function bodies: line tables are done (`-g` locs on every op, subprograms from src/mlir-debug.ts); named locals and params of every type but closures, arrays and Heap are done (`milo.dbg.var`, under `-g` only: a stack slot per named binding, lowered to `dbg.declare` by `milo-lower-debug-vars` after the function has its subprogram; enums are a tag enumeration plus a per-variant payload union, niche Options the payload alone, strings, Vecs and HashMaps their header fields, all laid out from the converted LLVM types). Still open: pattern- and loop-bound variables (`match` arms, `for` indices) have no `milo.dbg.var`, and closure, array and Heap values have no DI type.
- `!range`/`!noundef` on loads of ranged ints (`tests/refParamAttrs.test.ts`).

Both open items above are tracked under "MLIR parity gaps" in `docs/roadmap.md`.

## The module

milo-opt's LLVM IR is the whole module; there is no LLVM text written in TypeScript and no
splice. `MlirPlan.compile` (src/mlir-backend.ts) prints one MLIR module:

- **Globals and itables**: `milo.global.def` (src/const-fold.ts is the one folder: a
  run-time-initialized global is zero plus its constant fields) and `milo.itable`, whose
  destructor slot is the type's drop glue (`milo.drop.<key>`, src/mlir-glue.ts).
- **Every function** through the milo dialect, the init functions of src/startup.ts among
  them (`__milo.global_init` for globals nothing reads, `__milo.lazyinit.G` for the
  rest). A function's linkage (internal unless exported or `main`), `alwaysinline`, and
  its by-ref params' `nonnull dereferenceable align` and `noalias` are func.func and
  argument attributes (src/mlir-ctx.ts). `noalias` is decided on the HIR (src/noalias.ts).
- **The glue**: display, eq, clone, drop and hash per type, in the dialect.
- **The scaffold**, `module @milo.scaffold` in the LLVM dialect (src/scaffold.ts, through
  the typed builder src/mlir-llvm.ts): process globals, `__milo_process_init` (argc/argv,
  record/replay start, MILO_LINE_BUFFERED, the hash seed's replay mode, global init), the
  real `main` when main runs as a green task (`schedulerRunMainRaw` + `__milo_main_task`;
  the analysis is src/startup.ts's, on the HIR), the panic routines and panic tail, string
  writes, the hash seed source, the lazy-global machinery, and a `milo.cabi.<f>` shim per
  extern passing a struct by value (byval/sret/coerce from src/abi.ts). It is a module of
  its own so each side verifies alone: a C symbol a user extern also declares is one
  declaration after `milo-merge-scaffold` (mlir/Link.cpp) folds it in, after
  convert-milo-to-llvm. Scaffold symbols are on demand: whatever nothing uses is deleted.
- **Module attributes** milo-opt applies after translation (mlir/Link.cpp `finishModule`):
  `milo.runtime_ir`, the atomics of src/runtime/atomic.ll (single LLVM atomic
  instructions with a memory order Milo cannot spell; src/runtime-ir.ts), parsed and linked with `llvm::Linker` (names promoted for the link
  and made internal again); `milo.link_names`, per-module extern views of one C symbol;
  `milo.sanitize`, the `sanitize_*` attribute on every defined function; and
  `milo.replay_heap`, std/replay's allocator family on every allocation call.
- **-g**: the compile unit is fused into the module's loc and a subprogram into each Milo
  function's and closure body's loc (src/mlir-debug.ts); glue and the scaffold get none,
  so their code takes the caller's line when inlined. `milo-lower-debug-vars` turns
  `milo.dbg.var` into `dbg.declare` in those subprograms.

Types are the identified LLVM structs mlir/Scalar.cpp's converter builds from src/layout.ts's
names; the scaffold spells the ones it needs the same way (src/mlir-ctx.ts dialectType), and
the converter's `setBody` refuses a body that differs.

The runtime helpers are Milo, not IR: std/rt.milo holds the string buffer's reference count,
concat/append/compare, int and float formatting, map and Vec buffer allocation, FNV hashing and
the closure/interface drops, as ordinary std functions over raw pointers. The prelude imports
it, so every program carries them as plain module functions (unused ones are dropped), inlinable
like any other code. The backend calls them by symbol (`rtStringAppend`, `rtStrShare`, ...:
src/emit-mlir.ts, src/mlir-glue.ts, mlir/Drops.cpp). Only the atomics stay IR text.

## Gates

- **Corpus diff**: `bun test tests/run.test.ts` passes. `bun scripts/mlir-same.ts` builds
  every fixture through MLIR and compares stdout, stderr and exit status with the recorded
  goldens in `tests/golden` (the frozen oracle; never re-record from MLIR output except
  deliberately, with a note in the commit), and prints coverage and build time; it fails when
  nothing went through MLIR. `--programs` runs only `mlir/test/programs/` (scalar programs and
  one per trap, seconds), which `mlir/run.sh` runs too.
- **FileCheck tests** per pass and per lowering, in `mlir/test/`, each run by its own
  `RUN:` line from `mlir/run.sh`; `verify.mlir` covers the op verifiers.
- **Dialect hygiene**: `bun scripts/dialect-hygiene.ts` green, and every test file and emitted
  program module round-trips (`mlir/run.sh`; see Dialect hygiene).
- **Ownership**, required for any commit touching ownership lowering (owned slots, scopes,
  moves, drops, drop elaboration): `bun scripts/mlir-same.ts --programs --owned` before
  committing, the full corpus with `--owned` in the background. For every program, live heap
  blocks at exit must equal the golden's (`scripts/livecount.c`, a malloc/free counter
  injected with DYLD_INSERT_LIBRARIES; on Linux LeakSanitizer covers it), at -O2 and on
  `--fast` (-O0) builds, and the binary must run clean under ASan
  (`ASAN_OPTIONS=symbolize=0`: symbolizing needs the task port, which hangs on macOS). The
  output diff cannot gate this: an output-identical build can still free twice or leak.
- **Cross targets**: `bun scripts/mlir-cross.ts`.
- **Compile time** of the corpus is recorded by the gate. A regression is a problem to fix
  (in-process C API, bytecode, compiling std once), not a reason to stop.

## Toolchain

`mlir/` builds `milo-opt` against an installed MLIR (Homebrew LLVM 23.1.3 today) with one
CMake configure: `sh mlir/build.sh`. A default build compiles the whole module with the
clang of that same LLVM (`/opt/homebrew/opt/llvm/bin/clang`), never Apple's: LLVM 23 IR fed
to clang 21 is version skew, and a `MILO_CC` of another version is an error, cross builds
included. A cross toolchain's clang (`MILO_CC`, with `MILO_SYSROOT` and lld) only compiles
and links, but it consumes milo-opt's IR, so it must be Homebrew LLVM 23's too. The wasm64
build uses the same clang. MLIR's C++ API changes every release, so the LLVM version is
pinned and bumped on purpose.

A default build without a built `milo-opt` is an error naming the build command, never a
silent fallback. `milo-opt` is found at `mlir/build/milo-opt` in a checkout, else next to the
`milo` binary (what install.sh, the Homebrew formula and the deb/rpm ship; `MILO_OPT`
overrides). Release archives carry a statically linked milo-opt (`MILO_OPT_STATIC=1 sh
mlir/build.sh`; about 235 MB stripped, trimming the linked MLIR set is open work); the
darwin-x64 archive has none (no x86 MLIR on the arm64 runner), so Intel macs build it. CI
builds it through `.github/actions/milo-opt` (Homebrew on macOS, apt.llvm.org LLVM 23 on
Linux), cached on the hash of `mlir/` sources and the LLVM version.

## History

The migration ran in milestones M0 to M7 from 2026-10-31 to 2026-11-02. The legacy LLVM-text
backend was deleted at 7d2dd24c; `tests/golden` is the recorded oracle that replaced the
legacy/MLIR differential. The full log is in git history: `git log -p -- docs/mlir-backend.md`.
