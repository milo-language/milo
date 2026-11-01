<!-- doc-meta
system: mlir-backend-plan
purpose: plan for replacing the LLVM-text codegen with HIR -> milo MLIR dialect -> LLVM, one function at a time, now the default build (MILO_LEGACY=1 opts out)
key-files: mlir/Milo.td, mlir/Scalar.cpp, mlir/Drops.cpp, src/emit-mlir.ts, src/mlir-backend.ts, scripts/mlir-same.ts, docs/collections-in-std.md
update-when: a milestone lands, the coexistence scheme or the gates change
last-verified: 2026-11-01 (sixth batch: Tahoe Roads reasons by count; earlier: globals, closures, matches, big aggregates)
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
generates the replaced body, because its module-wide noalias dataflow reads every body. The path is the DEFAULT build; `MILO_LEGACY=1` is a temporary escape hatch (critical deploys only, see "Deploying apps built with MLIR"). `MILO_MLIR=1` is a no-op and `MILO_MLIR=0` means `MILO_LEGACY=1`, both for one release only. MLIR is on for every hosted target (cross builds and Windows included) and wasm64; legacy codegen is only the internal per-function fallback until coverage is 100%, then it is deleted. milo-opt emits for the TARGET: the module carries `llvm.target_triple` and `llvm.data_layout` (the layout clang uses for that triple, asked of milo-opt's own clang once per build), and the splice refuses a triple or layout the two halves disagree on. The one exception is the 32-bit Cortex-M family (`arch === "arm"`, `mlirTargetOk`): legacy `typeSize` and enum layouts hardcode an 8-byte pointer, while milo-opt sizes structs with the target layout (4-byte pointers), so the halves of one module would disagree on every struct holding a pointer; it moves when legacy sizes come from the target layout. `bun scripts/mlir-cross.ts` is the gate for non-host targets. The coverage number (MLIR functions / all
function instances over the corpus) is printed by the gate and must only go up. When it
reaches 100% the legacy codegen is deleted and the escape hatch goes with it.

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

**Fourth batch (2026-11-01): M5 start, globals, big aggregates, the first dialect rewrite.**

- *Globals.* `milo.global "name"` is the place of a module global (declared external, the
  splice keeps the module's definition); not an owned slot, so a store over it drops the
  old value as through a `&mut`. `milo.global.init` calls legacy's guarded entry
  (`__milo.lazy.<G>`) for a `LazyGlobalInit`, and `milo.store ... init` is a lazy global's
  first fill (HIR `isInit`: nothing to drop), so the `__milo.lazyinit.*` functions go
  through MLIR too. Thread-local globals stay legacy. A function naming a global keeps its
  legacy body for the noalias analysis (it reads `touches` from the text), as one with a
  raw pointer does; so does `main`, which therefore stays legacy when it names one.
- *Fn values and closures.* `!milo.fn<(params) -> ret>` is a non-owning fn value
  (`{ ptr fn, ptr env }`). `milo.closure @body(captures)` builds a by-reference closure:
  its body is a `func.func` of its own (internal, `(!milo.ptr env, params...)`), and the
  env is an entry-block slot of the creating frame with a null drop header and the
  captures' addresses (`milo.env.capture %env[i]` reads one back inside the body).
  `milo.closure.call` calls through the pair with the env first. A named fn as a value is
  legacy's trampoline, through a helper (`milo.fnval.<f>`). Closure bodies are appended
  to the module whole; the creating function keeps its legacy body for the analysis
  (byRefClosures, indirect calls). Still legacy: `move` closures and every owning fn type
  (their heap env has drop glue: next), heap-env and key-extractor closures, a closure
  with captures in a global initializer (legacy gives that env a static slot), slice
  params. The HIR type of a fn-typed field has lost its params; the struct layout's is used.
- *Matches.* An owning enum matched by value: an arm that binds an owning payload field
  moves the subject out of its owned slot (`milo.move`) and binds owned slots, so drop
  elaboration sees the subject empty on that path only (legacy's alive flag); an arm that
  leaves an owning field unbound stays legacy (legacy leaks it). A `&mut` subject binds
  payload places (`milo.enum.field_ref`). String and float literal patterns are a chain of
  `==` tests in nested `milo.if`s. Still legacy: nested patterns, niche-packed enums
  (ranged ints are not in the dialect at all), a 128+ byte enum matched by value.
- *128+ byte aggregates* are places, never SSA values (legacy's isBigAgg: SROA splits a
  whole-aggregate load per element). `placeType` admits them, `valueType` does not: by-ref
  params and args, field places, a by-value param (stored to its slot on entry, as legacy
  spills it), a by-value argument (loaded whole at the call, as legacy does), a big enum
  matched through `&`/`&mut` (`milo.enum.tag_at`, payload places). sret functions take
  legacy's hidden out pointer first; `return` writes a struct literal field by field
  (`init` stores) or forwards an sret call, and `let x = f()` gives the call `x`'s slot;
  `milo.filled` tells drop elaboration an owned slot was filled in place.
- *`s = s + x`.* `milo.string.concat` replaced the helper call, and
  `milo-append-in-place` (before scope-drops) rewrites `%l = load %s; ...; %r = concat %l,
  %x; store %r, %s` to `milo.string.append %s, %x` (legacy's pushStr) when nothing in
  between names `%s` and `%x` is not a view of it. 200000 appends: 2.13 s before, 0.01 s
  after, the same as legacy (`mlir/bench/append.milo`). The first optimization the
  dialect does that legacy did by matching its own Assign.
- *Canonicalize* runs with arith's `SelectToExtUI` off: it folded a select of Milo's si32
  (an if-expression `if b { 1 } else { 0 }`) into an `extui`, which only takes signless ints.
- *Gates.* Programs `globals`, `closures`, `append`, `match-forms`, `bigstruct`, `sret`
  (with `lib/bigs.milo`); FileCheck `globals.mlir`, `closures.mlir`, `append.mlir`,
  `match-mut.mlir`, verifier cases for the new ops. Planted bugs, each red: no drop before a
  store over a global (`globals`, one more live block); captures stored in reverse
  (`closures` ran away to the 4 GB guard); `append` with the left operand (`append`
  stdout); `milo.load` instead of `milo.move` in a consuming match arm (`match-forms`, ASan
  heap-use-after-free); field_ref index swapped on big structs (`bigstruct` stdout); the
  tag read 8 bytes in (`bigstruct` exit status); no `milo.filled` (`sret`, 14 more live
  blocks); a big by-value argument loaded instead of moved (`sret` double free).
  `MILO_MLIR_ONLY=<regex>` limits MLIR to matching function names, for bisecting.

**Fifth batch (2026-11-01): gate audit and std fixes.**

- *Vec.map to a fixed array.* `vecMapStd` reported a heap-buffer-overflow under ASan in
  both backends. Not map, not `@inline`: the checker substituted a type argument into a
  use site with the use site's array flags, so `*T` with T = [i64; 2] became `*i64`, and
  vecWithCapacity's `_vecGrowBuf(0 as *T, ...)` sized the buffer at 8 bytes a slot
  (`wrapTypeArg`). The reverse, T = `*[i64; 2]`, spelled the pointee as a struct name.
  Regression fixtures `vecMapFixedArrayStd` (ASan red without the fix, both backends) and
  `genericPtrToArrayArg`. The other 42 `vec*Std`, `str*Std` and `hashMap*Std` fixtures
  ran clean under ASan on both backends.
- *Live-block counter.* Erasing every drop of a struct of strings left the count equal to
  legacy's, for two reasons. At -O2 LLVM deletes a malloc whose block is never read, so a
  string that is built, measured and leaked is never allocated: the count now also runs
  on `--fast` builds of both sides. And libSystem's own allocations (stdio, locale) varied
  with the binary's layout, one block apart between legacy and MLIR at -O0 on six
  programs that allocate nothing different: only calls from the executable's `__TEXT`
  count now, and a counter that found no executable fails the gate. Planted bug: a no-op
  struct drop helper (`emitMlirDropFn`) turned the new program `string-fields` red only
  through the -O0 count ("legacy 0, mlir 15"), and `append`, `owning-aggregates` and
  `sret` red at -O2 as before.
- *StrReserve* (`_strReserve`, std's `string.push`): a call of a legacy function per call
  line taking the string's place (`milo.str.reserve.<line>.<file hash>`), so the room test,
  the copy out of a shared or static buffer and the out-of-memory panic's line are
  legacy's. Program `str-push`; planted bug: reserving 0 bytes instead of `n` turned it
  red (ASan heap-buffer-overflow). Tahoe Roads api: 2705 to 2997 of 5263 function
  instances (51.4% to 56.9%).
- *User `impl Drop`.* A struct or enum with its own Drop is marked after its name
  (`!milo.struct<"Noisy" drop, si64>`): it has drop glue whatever its fields hold, and
  the glue is legacy's (`milo.drop.<key>`), which runs the user's drop first. Named
  locals, params, moves, overwrites, results and scope exits drop where legacy drops them
  (last declared first, the old value after the new one is computed). Temporaries do not:
  legacy drops an argument temporary right after its call and others at the end of the
  statement, this backend at the end of the block, so a temporary of such a type keeps
  its function legacy (`tempSlot`), except a discarded result (`mk(1)` as a statement),
  which gets a scope of its own that closes at the end of the statement. Found on the
  way, for every owning type: an owned operand still pending when a later operand jumps
  out (`take(tok(), match o { None => return 0, ... })`) was an SSA value no scope drops,
  so it leaked (a Drop that did not run in `propagatePendingExits`); such a jump now keeps
  the function legacy (`noPending`). Program `user-drop`, FileCheck `user-drop.mlir`.
  Planted bugs, each red on stdout: the discarded result dropped at the end of its block
  ("after" printed before "drop 70"); the pending-operand check off (the Drop of `mk(90)`
  missing). Tahoe Roads api: 2997 to 3149 (59.8%).
- *Print order.* `print("a ", f(1))` evaluated every part before printing any, where
  legacy writes each string part once it is evaluated (after the scalar parts before it):
  a part that prints, or panics, landed in a different place. Found by `user-drop`. Each
  string part that is not the last now ends a `milo.print partial` (no newline, the
  `.part` helper; the verifier requires the string at the end); an interpolated string
  still evaluates every part first, as `format` does. Programs `print-order`,
  `trap-print-part` (stdout before the panic); FileCheck in `print.mlir`, verifier case
  in `verify.mlir`. Planted bug: never splitting turned both red (stdout).
- *`move` closures.* `!milo.fn<owning (T) -> R>` is an owned value (needsDrop; its glue
  is legacy's for owning closures, `milo.drop.ownfn`, which calls the env's header). A
  `move` closure literal is a call of a legacy function made for it
  (`milo.mkclosure.<fn>.<k>`) taking each capture by value, whose body is legacy's
  genClosure: the heap env, its drop glue, the liveness flags, the run-once check and the
  closure body are legacy's. A capture moves out of its owned slot; a shared string
  capture passes `milo.string.share`. `milo.closure` refuses an owning type (verifier).
  Still legacy: a capture of a reference or of a type with a user Drop, heap-env
  (task) and key-extractor closures. Program `move-closures`, FileCheck
  `owning-fn.mlir`, verifier case. Planted bug: passing a capture with `milo.load`
  instead of `milo.move` crashed the -O0 build (`live blocks at exit at -O0: legacy 0,
  mlir null`, a double free). The 142 fixtures with a `move` closure: 141 same, 2
  nondeterministic on legacy too (http timing). Tahoe Roads api: 3190 of 5327 (59.9%;
  its function count moved from 5263 under me, the app is being edited).
- *std intrinsics* (`intrinsic` in emit-mlir): StrReserve, StrAlloc, StrRangeCheck,
  StrUnique, StringCstr, NumberToString and NonNegative are each a call of a legacy
  function doing exactly it, one per intrinsic, operand types and call site (line and
  column: the panics print both; StringCstr, which cannot panic, is one per type). A
  helper made inside a @trackCaller copy carries its `trackedCaller`, and `loc` now
  honours it too, so a panic names the caller as legacy's panicAt does. Found on the way:
  an owning element read through a raw pointer and only lent (`f(src[i])` with a `&T`
  param, a print part) went into an owned temporary slot and was dropped, freeing the
  Vec's strings under Vec.map (`vecMapStd` SIGBUS once map went through MLIR); such
  reads are bit copies now (`bitCopies`), lent from a slot that drops nothing. Programs
  `str-intrinsics`, `trap-negative-capacity`, `ptr-borrow`. Planted bugs: a helper
  without the trackCaller span (`trap-negative-capacity` stderr named std/vec.milo:542);
  StrRangeCheck with start and end swapped (`strings`, `str-intrinsics`,
  `trap-substr-oob` red); bit copies not recorded (`ptr-borrow` exit 0 -> 1). Programs
  coverage 66.2% to 94.6%. Tahoe Roads api: 3190 to 3611 of 5330 (67.7%).
- *`for x in v`* over a Vec param, local or field (not consumed, not `&mut` elements):
  data and len read once as legacy does, a `milo.while` on an index slot that moves on
  before the body (so `continue` cannot skip it), the element read through
  `milo.ptr.elem`/`ptr.load` at the top of each iteration and bound as a view. Program
  `for-each`; planted bug: `le` for `lt` in the condition (`for-each` exit 0 -> 1, a read
  past the end). Tahoe Roads api: 3706 of 5350 (69.3%); left: element types without a
  value type (28), strings (18), consumed Vecs (11).
- *MapCopyOut* (`_vecCopyOut`/`_mapCopyOut`, behind Vec.clone, filter and HashMap.get):
  the same `intrinsic` call, the place lent (a Vec's as its header, `refOf`), the result
  owned. Program `copy-out`; planted bug: a shallow copy instead of the deep one
  (`copy-out` exit 0 -> 1). Tahoe Roads api: 3801 of 5350 (71.0%).
- *A 128+ byte enum matched by value*: through its place, as by reference: a local's
  slot, or a slot of the block the subject is built in. An arm that binds an owning
  payload reads the bound fields out of the place, empties the subject's slot
  (`milo.move`, the value unused) and stores each owning field into a binding of its own;
  a 128+ byte field passes through one SSA value on the way, as a big argument does. Other
  arms bind places and leave the subject to its scope's drop. Program `big-match`;
  planted bug: no `milo.move` (`big-match`: the -O2 build crashed, a double free). Tahoe
  Roads api: 3869 of 5350 (72.3%).
- *128+ byte enums below 512 bytes are values too* (`BIG_ENUM_VALUE_LIMIT`): legacy
  returns and passes an enum by value (only structs get sret), so it is an SSA aggregate
  there as well; larger ones, and every 128+ byte struct, stay places. `into` stores such
  a value whole into its slot. Program `big-match` (`wrap`, `viaLocal`); planted bug:
  the value not stored (`big-match` exit 0 -> 1). Tahoe Roads api: 3889 of 5350 (72.7%).
- *An arm's own binding as its value* (`let Some(v) = f() else { ... }`, `Some(v) => v` on
  an owned subject): moved out of the arm's slot (`milo.move`), as legacy moves an
  arm-local tail; it was "block value copies a borrowed value" (144 in Tahoe Roads).
  Copying a view out of a place at a tail (legacy's cloneViewValue) is not needed by
  anything measured: strings arrive as `StringClone`, and the checker refuses moving an
  owning struct out of a borrow. Program `tail-views`; planted bug: `milo.load` for the
  move (`tail-views` stdout, a use after free). Tahoe Roads api: 3992 of 5350 (74.6%).
- *Fields as `&T` arguments*: a Vec field of a place is lent as its header
  (`milo.vec.place`); a field of a value (an immutable binding) from a slot of its own that
  drops nothing. Program `field-args`; planted bug: the spill slot never written
  (`field-args` stdout). Tahoe Roads api: 4051 of 5350 (75.7%).
- *Not done, by measurement.* Interfaces: 13 fixture files use one, the dyn calls block 5
  function instances there and none in Tahoe Roads, against 27 blocked by `Heap`, which
  the dialect lacks entirely; left for after Heap. A statement-level scope for user-Drop
  temporaries: 13 instances over the 80 Drop fixtures, none in Tahoe Roads; legacy's
  timing differs per construct (an argument temporary dies after its call, a print part
  after the print), so it is a scope per consuming op, not per statement, when it is done.

**Sixth batch (2026-11-01): Tahoe Roads' top legacy reasons, by count.**

- *128+ byte values between places* (`milo.copy %src, %dst : <ref or ptr>, <ref or ptr>
  of T`, one memcpy of T's size, as legacy's emitMemcpy): std's `push`/`insert` store a
  big element through a raw pointer, `let v = w` and `return w` copy a big local, a big
  element is read out of a pointer into a slot. The value never becomes SSA. An owned
  source given up is emptied by an unused `milo.move`, which now lowers to nothing (a
  dead whole load of a big aggregate is still split per element by SROA). Program
  `big-elems` (with `lib/wides.milo`: functions of the entry file keep a by-value
  result, so the sret ones live in a module), FileCheck `copy.mlir`, three verifier
  cases. Planted bug: no `milo.move` after the copy into the element (`big-elems` exit
  0 -> 1, a double free of the pushed Row). Tahoe Roads api: 4051 to 4151 (77.6%).
- *`?`* is the match it means, built as HIR and emitted by `match`: `Ok(v) => v` (tag 0;
  Some), `Err(e) => return Err(e)` in the function's result enum, wrapped in the From
  variant first for a conversion. The return is a return statement's, so scope drops run
  before it and a pending owned operand keeps the function legacy, as for any return.
  Still legacy: a `?` boxing its error into `Heap<Iface>` and one turning it into a
  message. Program `propagate`; planted bug: the early return built with the result
  enum's Ok variant (`propagate` stdout). Tahoe Roads api: 4169 (77.9%): of the 78
  functions it blocked, most now stop on what comes next (variadic calls, user-Drop
  temporaries).
- *A Vec of non-scalars indexed* (`milo.index.ref %v[%i] : !milo.vec<T> -> !milo.ref<T>`,
  the element's place after legacy's bounds check; milo-expand-index makes it len,
  bounds_check and `milo.vec.elem_ref`): lent to `&T`/`&mut T` arguments as legacy's
  genLValueForArg lends it, read and written field by field, stored over (milo-scope-drops
  drops the old element first), a Vec element lent as its header, `grid[i][j]`. Read as
  a value, an owning element is legacy's deep copy of the place (the MapCopyOut helper,
  now `copyOut`); a 128+ byte one is copied with milo.copy when it owns nothing. A
  `!milo.ref` into Vec element memory does not break the Slot resource's promise in
  practice: vec.load and vec.store only ever touch Vecs of scalars, and those elements
  are never reached through one. Programs `vec-elems`, `trap-index-struct-oob`;
  FileCheck `index-ref.mlir`, a verifier case. Planted bug: the element read as a bit
  copy instead of the deep copy (`vec-elems` exit 0 -> 1, a double free). Tahoe Roads
  api: 4235 (79.2%).
- *Fixed-size arrays* (`!milo.array<T, N>`, LLVM's `[N x T]`) of elements that own
  nothing: places only at any size, as 128+ byte aggregates are, and so is any struct
  or enum holding one; an SSA array exists only at the ABI. `[v; n]` stores `v` in a
  `milo.for` (LLVM makes the memset of a zero one), `[a, b]` stores each element as it
  is evaluated; `a[i]` is `milo.array.index` (legacy's bounds check against N, then
  `milo.array.elem_ref`, a GEP); an array decays to its address for a `*T` argument or a
  cast, as legacy; a struct literal builds an array field in its own place. Helper names
  spell an array `arr<N>.<elem>` on both sides (Vec<[i64; 3]>'s growth and drop). Vec
  literals are a legacy function per element type and count (`milo.veclit.<key>.<n>`,
  genArrayLit's one malloc of exactly n), the elements evaluated in order and moved into
  it; `[]` is `milo.vec.new`. Still legacy: slices, arrays of owning elements, a small
  struct holding an array returned by value, `for x in` an array. Programs `arrays`,
  `trap-array-oob`; FileCheck `arrays.mlir`, two verifier cases. Planted bug: array
  literal elements stored in reverse (`arrays` stdout). Tahoe Roads api: 4364 (81.6%).
- *Branches yielding a place-only value* (a match, an if, a let-else, a `?` whose value
  is a 128+ byte struct): `into` fills the destination from each arm (`tailInto`: the
  arm's statements, then its last expression built in the place, or the arm's own owned
  binding copied and emptied), as legacy's genStoreInto; the match is a statement
  milo.match, and an arm that returns leaves the place unfilled on that path. Program
  `big-branches` (with `lib/branches.milo`). Planted bug: the arm's binding copied out
  but not emptied (`big-branches` exit 0 -> 1, a double free). Tahoe Roads api: 4415
  (82.5%).
- *Ranking by the whole corpus.* From here the order is the corpus-wide count of blocked
  function instances (a compile-only census: emit-ir with MILO_MLIR_LOG over every
  fixture, every example with a main and milojs's two entry points), not one app's.
  After the branches above: 397979 of 483984 (82.2%); fixtures 82.4%, examples 81.7%,
  milojs 79.0%. Top reasons: thread-local global 6946, load through a pointer of a
  struct 6432, `pushStr` 4720, argument copying a borrowed value 4337, variadic call
  3926, StrPanic 3405, the atomic builtins about 12000 together.
- *Thread-local globals* (`milo.global "g" thread_local`, declared `thread_local` in the
  MLIR module; the address is a plain use of the symbol, as legacy takes it) and globals
  that are places only (fixed-size arrays, 128+ byte structs): a global is now bound by
  its place type. Program `tls-globals`, a FileCheck case in `globals.mlir`. Planted bug:
  a thread-local scalar read and written through a fresh slot instead of its global
  (`tls-globals` stdout). The full `--owned` corpus run on the first commit of this
  batch was 1092 of 1093 same: `channelCrossThreadPark` had 13 live blocks at exit on
  legacy and 0 on MLIR once, same on two reruns (threads still alive at exit). Corpus:
  405026 (83.7%); Tahoe Roads api: 4441 of 5351 (83.0%).
- *`*p` of any type* is a place reached through a pointer (ptrPlace): read whole as a bit
  copy that owns what the memory owns (as `p[i]` already was), written whole with
  nothing dropped, `(*p).f` read and written in place, a 128+ byte one copied with
  milo.copy. Program `ptr-structs` (in a function of its own: a main naming a raw pointer
  keeps its legacy body). Planted bug: `*p` addressing the element after p (`ptr-structs`
  stdout the same, `--owned` red: ASan heap-buffer-overflow). Tahoe Roads api: 4472
  (83.6%).
- *`s.pushStr(x)`* is `milo.string.append` (legacy's pushStr through the helper that
  milo-append-in-place already used), onto any string place; a temporary `x` dies at
  the end of the block. Program `push-str`. Planted bug: the temporary not put in a slot
  (`push-str` `--owned` red: 5 more live blocks at exit). Taking pushStr put more of
  the string fixtures' mains through MLIR and found a bug from the third batch:
  `milo.string.share` declared only a read of its slot, so CSE folded the two shares of
  `pair(s, s)` into one value passed twice (one count for two owners: a use after free,
  `valueStringUseAfterPass` stdout, `valueStringStruct` ASan). It writes the count now;
  FileCheck `share.mlir`. Corpus: 413391 (85.4%); Tahoe Roads api: 4497 (84.0%).
- *Extern calls with C strings, and variadic calls* (`milo.ffi.<fn>.<shape>.<site>`): the
  call itself is legacy's genCall in a legacy function, so the string to `*u8`
  conversion (a static or view string copied to a NUL-terminated temporary for the
  call) and the variadic promotion are legacy's. A string goes to it by reference; one
  this function owns outright (a local, a field of one, a temporary) is first made the
  only handle to its buffer, as legacy's emitCStrUniquePlace does (C may write through
  the pointer), with the StrUnique helper. A temporary given to a libc call that keeps
  its pointer stays legacy (legacy leaks it). Program `ffi-strings`. Found on the way: an
  intrinsic helper takes its result type from the expression it stands for, so a
  unique made for a call returning i64 fell off the end of an i64 function (a trap at
  -O2 only). Planted bug: the temporary in a slot that drops nothing (`ffi-strings`
  `--owned` red: one more live block). `s.cstr()` through MLIR (the
  fifth batch's StringCstr helper takes the place by reference) never made an owned
  local unique first, where legacy does; it does now (program `cstr-unique`, stdout red
  without it: C's write reached the shared copy). Corpus: 417093 (86.2%); Tahoe Roads
  api: 4525 (84.6%).
- *Builtins that only read their operands* (atomics, exit, flush, `_cstrToString`,
  `_bytesToString`, `_strDataPtr`, `_miloArgAt` and the other byte and scheduler
  accessors; `HELPER_BUILTINS`): legacy's code for each in a legacy function per
  builtin, operand shape and call site (`milo.builtin.*`), a by-ref operand as its
  place. Program `builtins`; its prints are in a function of their own because a
  temporary in this backend dies at the end of its block, and `exit` before the end of
  main's block leaves one more live block at exit than legacy, which drops it at the
  end of the statement (only the live-block count can see it). Planted bug: a string
  result not owned (`builtins` `--owned` red at -O0: one more live block). `exit` ends
  its path as a jump does (HIR types it void): `take(s); exit(1)` on one branch then
  `print(s)` failed drop elaboration ("may be empty"), caught by `exitDivergesMoves`.
- *std's panics* (`_strPanic`, `_vecPanic`: HIR StrPanic, VecPanic) are intrinsic helpers
  per message and site, and end their path as exit does. *addrOf* of an immutable SSA
  binding moves it to a slot from there on (legacy's alloca: a write through the
  address is seen by later reads), and of a place behind a pointer is that pointer
  (`data[i].addrOf()` in std's insert and remove). Programs `trap-vec-insert`,
  `trap-str-truncate`, `addr-of`. Planted bugs: the binding spilled but not rebound
  (`addr-of` stdout: 40 for 41); the panic's value replaced by 0 (`trap-str-truncate`
  stderr).
- *`x ?? d`* is the match it means (`Some(v) => v`, `_ => d`), also into a place for a
  128+ byte result. A `??` over a Result whose Err owns something stays legacy: legacy
  never drops that payload (one more live block at exit than this backend, which
  drops it), so taking it would change the leak count. Program `default-value`.
  Planted bug: the Some arm yielding the default (`default-value` stdout).
- *`zeroed<T>()`* is `milo.zero : T` (LLVM's zero of the type; for a string or a Vec
  the empty one), stored whole into the place of a place-only T. A fn value has no zero
  (verifier). Program `zeroed`, FileCheck in `scalar-to-llvm.mlir`, a verifier case.
  Planted bug: an i64 zero emitted as 1 (`zeroed` stdout).
- *Interpolated strings as values* (`format`): the builtin helper with every string part
  lent from its place (print already printed the parts without building the string).
  Program `format`. Planted bug: the result not owned (`format` `--owned` red: 4 more
  live blocks).
- *A 128+ byte temporary lent as `&T`* (`show(picked(p))`, an sret call or any
  place-only value) is built in a slot of the block, which drops it. `big-branches`'s
  main goes through MLIR now. Planted bug: that slot not owned (`big-branches`
  `--owned` red: 8 more live blocks).
- *`for x in v` over place-only elements* (128+ byte structs, arrays) binds `x` as the
  element's place (`milo.index.ref`, in bounds by the loop condition). Program
  `big-for`. Planted bug: every iteration bound to element 0 (`big-for` stdout).
- *A string given to a `*u8` param of a Milo function* gets the same C string
  conversion as for an extern (legacy keys it on the signature, not on extern), so it
  goes through the `milo.ffi.*` helper too (`plen` in `ffi-strings`; the temporary
  plant above turns it red the same way).
- *A 128+ byte payload of an enum that is a value* (`Some(row(i))`, a derived clone of
  `Result<Row, E>`) passes from its slot through one SSA value, as a big argument does
  (bigArg). `maybeRow` in `big-branches`. Planted bug: the temporary loaded instead of
  moved out of its slot (`big-branches` stdout, a use after free).
- *A call is a scope of its own* (callScope): the temporaries its by-ref arguments lend
  from die right after it, before its result is used, as legacy's argTempDrops; so an
  argument temporary with a user Drop (`peek(mk(1))`) is taken, its drop where legacy
  prints it. Other user-Drop temporaries (a field of one, a print part) stay legacy.
  Found on the way: a store over an owning field never registered the old value's drop
  glue, so `self.items = Vec.new()` linked only when something else had (`arenaDropElements`
  at -O0). Program `drop-args`. Planted bug: calls not scoped (`drop-args` stdout: the
  drops after the statement). A match subject temporary with a user Drop is taken when
  every arm binds every owning payload field (`let f = File.openRead(p)?`): every path
  empties its slot, so no drop of it ever runs. Planted bug: any subject taken (the
  legacy-only `other` in `drop-args` then drops after "after": stdout).
- *An owning field moved out of a local* (`take(r.name)`, nested, a Vec field, a 128+
  byte one by milo.copy): read out, then the field zeroed in place by an `init` store,
  as legacy zeroes it, so the struct's drop finds an empty one; not when a struct on
  the way runs a user Drop. Program `move-field`. Planted bug: no zeroing (`move-field`
  exit 0 -> 1, a double free).
- *`for b in s` and `s as *u8`* read the string's data pointer (`milo.string.data`,
  field 0) and its len once, as legacy's genForEach and genCast. Program
  `string-bytes`, FileCheck in `pointers.mlir`. Planted bug: the walk starting one byte
  in (`string-bytes` stdout).
- *`x!`* is legacy's genUnwrap in a helper per enum and site, the operand moved into
  it; *`forget(x)`* takes x into an SSA value nothing drops. Programs `trap-unwrap`,
  `forget` (the ownership counts skip a program that panics, so forget has its own).
  Planted bugs: the forgotten value dropped (`forget` `--owned`: legacy 2 live blocks,
  MLIR 0); the unwrapped payload not owned (legacy 2, MLIR 3).
- *isSome/isNone/isOk/isErr* are tag tests (`enum.tag`, or `tag_at` of a place-only
  enum's place) and *unwrapOr* is `??`; the closure-taking ops (map, andThen, orElse,
  unwrapOrElse) stay legacy. Program `option-ops`. Planted bug: the test inverted
  (`option-ops` stdout).

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

### Verification from the compiled IR (decided)

Contracts (`requires`, `ensures`, loop invariants) lower to the upstream `smt` dialect
from the same milo IR that is compiled, so what is proven is what runs, rather than a
separate model of the source (`src/verify.ts` today). The `smt` ops export through
upstream's SMT-LIB exporter to z3, or to Milo's own QF_LIA solver (`std/smt`), which
`src/prove-milo.ts` already drives from SMT-LIB text.

### Raising: modernize and harden source through the dialect

JSIR's defining trait is that it round-trips: source goes up into the dialect, passes
transform it, and it prints back as source. Milo gets the same:

- The top layer stays source-faithful (for-in, `?`, interpolation kept as ops; desugaring is
  a pass), and the emitter reads the checker's output rather than desugared HIR.
- A dialect-to-Milo printer plus `milo fmt`; edits are minimal so comments survive.
- Proof gate per rewrite: the printed source re-parses to the identical top-layer dialect,
  and a pure refactor lowers to identical normalized IR.
- Rewrites: `var` to `let`; unwritten `&mut T` to `&T`; read-only owned private params to
  `&T`; last-use clone to move; string clone removal; ranged-type inference; dead
  `@wrapping`; unsafe pointer loops to slices; contract inference and static proof;
  `@pure` and effect inference; index loops to for-in; match on Result to `?`; loops to
  fold/any/find; `isSome` plus unwrap to `if let`; std API migration; dead code. First
  proof of concept: `var` to `let` and `&mut` to `&`.

### The dialect as a product

Anything that emits valid milo dialect gets Milo's semantics and lowering; the first such
client is the self-hosted frontend. Needed: op and dialect docs generated from `Milo.td`
(`mlir-tblgen -gen-dialect-doc`, gated, never hand-written), a `libMiloDialect` library
and C API, and a versioned format after M7 (MLIR bytecode dialect versioning). The
verifiers are the contract a client codes against.

### Deploying apps built with MLIR

Critical apps (Tahoe Roads) move only after: M4 green under the ownership gates over the
corpus and the milojs apps; a per-app record/replay differential (record real traffic
with the legacy build, replay it against the MLIR build, byte-diff the responses, repeat
under ASan); a shadow run, then a canary through the existing socket-activated restart
(`ops/restart-gate.sh`) with the legacy binary kept for rollback. Server hot paths need M6
(tasks) before a canary is meaningful. The default is already on, so until an app's differential passes its deploy script keeps
`MILO_LEGACY=1` (the build is the legacy codegen byte for byte); drop it per app after the
canary.

## Gates (every milestone, every commit)

- **Corpus diff**: `bun test tests/run.test.ts` under the default passes exactly as with
  `MILO_LEGACY=1`. `bun scripts/mlir-same.ts` builds every fixture both ways and diffs stdout, stderr
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
  Linux LeakSanitizer covers it), counted at -O2 and again on `--fast` (-O0) builds, and
  only for calls made from the executable's own code and the MLIR binary must run clean under ASan
  (`ASAN_OPTIONS=symbolize=0`: symbolizing needs the task port, which hangs here). The
  output diff cannot gate this: making maybe-init drops unconditional left it green
  while ASan reported a heap-use-after-free (`--owned` red), and erasing every drop
  left 202 live blocks against legacy's 179 (`--owned` red).
- **Compile time** of the corpus, legacy vs MLIR path, recorded from M1. A regression is a
  problem to fix (in-process C API, caching, parallel CGUs), not a reason to stop.
- **Coverage** only goes up.

## Toolchain

`mlir/` builds `milo-opt` against an installed MLIR (Homebrew LLVM 23.1.3 today) with one
CMake configure: `sh mlir/build.sh`. A default build compiles the whole module with
the clang of that same LLVM (`/opt/homebrew/opt/llvm/bin/clang`), never Apple's: LLVM 23 IR
fed to clang 21 is version skew (it already rejects LLVM 23's float constant syntax), and
a `MILO_CC` of another version is an error, cross builds included: a cross toolchain's clang (`MILO_CC`, with `MILO_SYSROOT` and lld, as ~/git/digitalocean/milo-cross.mk sets them) only compiles and links, but it consumes milo-opt's IR, so it must be Homebrew LLVM 23's too. The wasm64 build uses the same clang. MLIR's C++
API changes every release, so the LLVM version is pinned and bumped on purpose.
A default build without a built `milo-opt` is an error naming the build command, never a
silent fallback. `milo-opt` is found at `mlir/build/milo-opt` in a checkout, else next to the
`milo` binary (what install.sh, the Homebrew formula and the deb/rpm ship; `MILO_OPT`
overrides). Release archives carry a statically linked milo-opt (`MILO_OPT_STATIC=1 sh
mlir/build.sh`; about 235 MB stripped, trimming the linked MLIR set is open work); the
darwin-x64 archive has none (no x86 MLIR on the arm64 runner), so Intel macs use
`MILO_LEGACY=1` or build it. CI builds it through `.github/actions/milo-opt` (Homebrew on
macOS, apt.llvm.org LLVM 23 on Linux), cached on the hash of `mlir/` sources and the LLVM
version.
