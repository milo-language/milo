<!-- doc-meta
system: mlir-backend
purpose: Measured plan to split src/emit-mlir.ts (first 6 extractions) and to emit derived Clone instances only when something refers to them
key-files: src/emit-mlir.ts, src/mlir-backend.ts, src/mlir-ctx.ts, src/mlir-glue.ts, src/checker-derive.ts, tests/emitMlirTypeSize.test.ts
update-when: an extraction below lands, emit-mlir.ts line spans drift, or the lazy-emission design changes
last-verified: 2026-11-09 (commit e4a02962, src/emit-mlir.ts blob 77a50499, 5939 lines)
-->

# emit-mlir.ts split and lazy derived-Clone emission

Status: proposed 2026-11-09. Plan only, no source was edited.

Every claim carries a tag: **[code]** read in the source, **[run]** measured by running
a script or the compiler, **[not verified]** neither.

Line spans are from commit e4a02962 and will drift, because `src/emit-mlir.ts` is under
active edit. Briefs name every declaration. Move by name and re-run the seam
script for current spans.

## Tools

    OPENED="T:PTR,T:STR,T:vecElem,T:refOf,T:isScalarTy,T:hasDebugType,T:typeKey,T:scalar,T:inSlot,T:isSsa,T:valueType,T:Owns,T:ownsStructurally,T:fieldTypes,T:ownsOf,T:placeType,T:closureParamType,T:lentType,T:viewResult,T:isTempBox,T:stripRefs,T:placeBlocker,T:blocker,T:quote,T:literalBytes,T:quoteBytes,T:floatLit"   # members already public after extraction 1
    bun scripts/emit-seam.ts . --top --members          # every top-level decl and FnEmitter member: span, state read/written, ctx members used
    bun scripts/emit-seam.ts . --dom                    # dominator subtrees of the member call graph (roots: constructor, run)
    bun scripts/emit-seam.ts . --pure                   # methods whose transitive closure writes no emitter state
    bun scripts/emit-seam.ts . --topcluster "23-77,81-88,116-535,553-610"      # cost of moving top-level line ranges
    bun scripts/emit-seam.ts . --cluster "match*" --opened "$OPENED"   # cost of one cluster; name* = dominator subtree
    bun scripts/emit-seam.ts . --greedy 7 --min 200 --max 900 --opened "$OPENED"

`scripts/emit-seam.ts` uses the TypeScript compiler API (checker symbol resolution, about
9 s per run). The Plan B numbers came from two throwaway probes that are not in the repo
(a module-text filter and a per-type-pair byte count); B1 to B4 each carry their own gate.
`--opened` takes names that are already public: `m` for a member, `T:name`
for a top-level name.

Cost of a cluster = entry points the rest of the file calls + private host members the
cluster uses + top-level names that must become exported. Members opened by an earlier
extraction are free for later ones.

---

# Plan A: split src/emit-mlir.ts

## What the file is

[run] 5939 lines. 92 top-level declarations in lines 23-666 and 5856-5939, and one
class `FnEmitter` at 668-5854 with 172 methods and 36 fields. Largest methods: `exprAt`
2863-3680 (818 lines), `match` 4217-4430 (214), `into` 960-1090 (131), `moveClosure`
3747-3868 (122), `call` 5740-5853 (114), `nestedMatch` 4474-4575 (102).

## How the earlier pieces were cut

[code] All four earlier extractions took code that does not touch FnEmitter's mutable
state:

| file | what moved | how it reaches the rest |
|---|---|---|
| `src/mlir-ctx.ts` | `ModuleCtx` | context object behind `interface MlirEmitCtx`; the emitter only sees the interface |
| `src/scaffold.ts` | startup and wrapper functions | free functions taking `ModuleCtx` and a facts record |
| `src/startup.ts` | `planStartup` | pure function returning a plan record, plus name constants |
| `src/emit-forms.ts` | AST readers | pure functions over AST and `Facts` |
| `src/mlir-glue.ts` | `MlirGlue` | class with its own state, takes `cx`, borrows five helpers through `glueHelpers` |

[run] That pattern is used up for the class. Only 23 methods (115 lines) have a
transitive closure that reads nothing but `cx`, `fn`, `fns`, `fx` and writes nothing.
The rest of the 5.2k-line class is one strongly connected call graph over shared fields
(`vars` has 28 writing methods, `owned` 18, `pending` 11).

So extractions 1 and 2 follow the old pattern (top-level code), and extractions 3 to 6
need a new one.

### Pattern for class clusters (decision)

Free functions in a new `src/mlir-emit-*.ts` file that take the emitter as first
parameter, the same shape as `scaffold.ts` over `ModuleCtx`:

- `export class FnEmitter` (one new export, paid once in extraction 3).
- The new file has `import type { FnEmitter, Val, ... } from "./emit-mlir"`. The import
  is type-only, so there is no runtime cycle. [run] Every top-level name clusters 3 to 6
  need from emit-mlir.ts is a type, once extraction 1 has moved the value helpers.
- The emitter parameter is named `fe`. [run] `fe` occurs 0 times in emit-mlir.ts today.
  Do not use `e`: most methods already use `e` for the expression being emitted.
- Inside moved bodies: `this.X` becomes `fe.X` for host members, and `this.m(args)`
  becomes `m(fe, args)` for members of the same cluster. Arrow functions need no change.
- Host callers: `this.match(a, b)` becomes `match(this, a, b)`.
- Every host member the cluster uses loses `private`. Fields the cluster assigns must
  not be `readonly`.

Rejected: a chain of abstract base classes (bodies would stay unchanged, but each layer
re-declares the signatures it needs from layers above, and the chain order is
arbitrary). Rejected: one sub-emitter class per cluster holding a back reference (same
cost in opened members, plus a constructor and a field per cluster).

Later module pairs (`mlir-emit-for.ts` and `mlir-emit-stmt.ts`) import each other at
run time. They only use each other's functions at call time, never at module load, so
ES module evaluation order does not matter. [not verified] by a run.

## Ranking

[run] Top-level block first, then dominator subtrees. "Cold" means nothing opened yet.
"Incremental" is the greedy order after extraction 1, where members opened by earlier
picks are free.

| candidate | lines | new exports | per 100 lines |
|---|---|---|---|
| top-level types block (E1) | 541 | 27 | 4.99 |
| module tail into mlir-backend.ts (E2) | 51 | 0 (removes 3) | 0 |
| `match` subtree, cold | 496 | 42 | 8.47 |
| `expr` subtree, cold | 1394 | 122 | 8.75 |
| `stmt` subtree, cold | 809 | 73 | 9.02 |
| `forIn` subtree, cold | 465 | 52 | 11.18 |
| `call` subtree, cold | 400 | 48 | 12.00 |
| `closure` subtree, cold | 206 | 46 | 22.3 |
| `into` subtree, cold | 234 | 57 | 24.4 |

Incremental (greedy, after E1):

| order | cluster | lines | new exports | per 100 lines |
|---|---|---|---|---|
| E3 | `match` subtree | 496 | 38 (+1 for `FnEmitter`) | 7.66 |
| E4 | `forIn` subtree | 465 | 18 | 3.87 |
| E5 | `call` subtree | 400 | 18 | 4.50 |
| E6 | `stmt` subtree | 344 | 22 | 6.40 |
| later | `into` subtree | 234 | 12 | 5.13 |
| later | `closure` subtree | 206 | 11 | 5.34 |

`match` goes first among class clusters even though its own ratio is the worst of the
four: it has the cheapest cold cost, and the 32 members it opens (`emit`, `def`,
`expr`, `fresh`, `region`, `stmts`, `vars`, ...) are the ones every later cluster needs.

Expected size of emit-mlir.ts: 5939 -> ~5400 (E1) -> ~5350 (E2) -> ~4855 (E3) -> ~4390
(E4) -> ~3990 (E5) -> ~3650 (E6). About 85 of 208 members end up public. The file
cannot get under the 1500-line ratchet limit until `exprAt` (one 818-line method, 1392
lines with its subtree) has its arms cut into per-form functions. That is a rewrite of
a method, not a move, and is out of scope for these six.

## NATIVE_BUILTINS duplicates part of BUILTINS

[code] `BUILTINS` (`src/mlir-ctx.ts:42`) is the full list. `NATIVE_BUILTINS`
(`src/emit-mlir.ts:657`) is a second literal used once, in `call` at line 5744:

    if (NATIVE_BUILTINS.has(e.func) || e.func.startsWith("_atomic")) return this.nativeBuiltin(e);

[code] `NATIVE_BUILTINS` plus the `_atomic*` names (all 16 keys of `ATOMIC_INTRINSICS`
in `src/runtime-ir.ts` start with `_atomic`) equals `BUILTINS` minus `print`, `eprint`,
`format`, `assert`, `todo`, `max`, `min`. `print`/`eprint` return before this branch,
and `format`/`assert`/`todo` have their own arms after it.

Derive one from the other by deleting the second list instead of computing it. Inside
`if (this.cx.isBuiltinName(e.func))`, put the three named arms first and make
`nativeBuiltin` the fallthrough:

    if (e.func === "format") return this.formatText(e.args, e.span);
    if (e.func === "assert") return this.assert(e);
    if (e.func === "todo") return this.todo(e);
    return this.nativeBuiltin(e);

[code] `max` and `min` then reach `nativeBuiltin`, which emits nothing before its
switch and ends with the same `throw new MlirUnsupported(\`builtin ${e.func}\`)`, so the
message is unchanged. Do not build a derived set with a spread: a shared list was tried
in 4361294c and reverted in c456a79b because the spread costs two ts-portable points.

Brief N1 (do before E5 so E5 moves three fewer lines):
- Edit: delete `NATIVE_BUILTINS` (656-658), rewrite the four lines of the dispatch as above.
- Invariant: emitted MLIR byte-identical; `builtin max` still reports `builtin max`.
- Gate: tsc filter empty; `bun scripts/ir-same.ts --emit mlir --base HEAD --filter atomic`,
  then `--filter extern`, then `--filter print`; `bun test tests/builtinNameDrift.test.ts`.
- Expected: emit-mlir.ts 5939 -> 5935, exports +0.
- Commit: `drop NATIVE_BUILTINS, nativeBuiltin is the builtin fallthrough`

## Gates shared by every extraction

Run in this order. All but the last finish in under a minute.

1. `bunx tsc --noEmit -p . | grep -E "^(scripts|src|tests)/"` prints nothing.
2. `bun scripts/ir-same.ts --emit mlir --base HEAD --filter <substring>` once per
   substring listed in the brief, before committing (`--base HEAD` compares the working
   tree with the last commit; the default base is `main`). Filter is a path substring,
   case-sensitive. Fixture counts [run]: match 25, enum 17, forIn 12, hashMap 19,
   closure 39, extern 27, print 4, Drop 56, vec 52, ifLet 9, letElse 5.
3. `bun scripts/file-size-ratchet.ts --update`, then `bun scripts/file-size-ratchet.ts`.
   (A shrink of 200 lines or more without a rebaseline is red. New files must be under
   1500 lines; all six are.)
4. `bun scripts/ts-portable.ts --write`, then `--check`. New files must be named
   `mlir-*.ts` to be counted (the script's FRONTEND pattern). For E1 and E2 the sum of
   the counts of source and destination files must be unchanged. For E3 to E6 it must
   not rise; report before and after. [not verified] whether dropping `private` or
   turning a method into a function changes a count.
5. Each new file starts with a one-line `//` purpose comment, then
   `bun run scripts/gen-src-doc.ts` (tests/srcDoc.test.ts checks `docs/src.md`).
6. Not blocking, in the background after the commit:
   `bun scripts/ir-same.ts --emit mlir --base HEAD~1` over all 1102 fixtures.

Invariant for all six: emitted MLIR is byte-identical. No behaviour change, no renames
other than the ones listed, no re-export shims left behind in emit-mlir.ts.

## E1: value and type helpers -> src/mlir-types.ts

- Move these top-level declarations (lines 23-77, 81-88, 116-535, 553-610; 55
  declarations, 541 lines): `MlirEmitCtx`, `MlirUnsupported`, `PTR`, `STR`, `mlirType`,
  `vecElem`, `refOf`, `isScalarTy`, `hasDebugType`, `typeKey`, `scalar`, `aggregates`,
  `typeDefs`, `spelledOrder`, the `F_*` flags, `TypeTable`, `tables`, `typeTable`,
  `typeFlags`, `BIG_ENUM_VALUE_LIMIT`, `recordType`, `holdsArray`, `inSlot`, `isSsa`,
  `valueType`, `Owns`, `ownsStructurally`, `fieldTypes`, `runsUserDropT`, `ownsOf`,
  `placeType`, `spellPlace`, `typeAliasText`, `fnType`, `closureParamType`, `lentType`,
  `hasUserDrop`, `aggregateType`, `viewResult`, `dynRef`, `isTempBox`, `stripRefs`,
  `placeBlocker`, `blocker`, `quote`, `literalBytes`, `HEX_DIGITS`, `quoteBytes`,
  `floatLit`.
- Stay in emit-mlir.ts: `CALLBACK_OPS` (79), `fnDebugLoc`/`debugLocOf`/`needsLoc`/
  `fillDebugLocs` (90-114), `patLiteral` (537-551), `Val` through `ClosureState`
  (612-654), `NATIVE_BUILTINS`, `ARITH`/`BITS`/`CMPS`, `X`.
- Interface: export the 27 names emit-mlir.ts uses: `PTR`, `STR`, `vecElem`, `refOf`,
  `isScalarTy`, `hasDebugType`, `typeKey`, `scalar`, `inSlot`, `isSsa`, `valueType`,
  `Owns`, `ownsStructurally`, `fieldTypes`, `ownsOf`, `placeType`, `closureParamType`,
  `lentType`, `viewResult`, `isTempBox`, `stripRefs`, `placeBlocker`, `blocker`,
  `quote`, `literalBytes`, `quoteBytes`, `floatLit`. `MlirEmitCtx`, `MlirUnsupported`,
  `typeAliasText` keep `export`. The other 26 stay unexported.
- [run] The block refers to nothing left in emit-mlir.ts. It imports from
  `./emit-forms`, `./ast`, `./types`, `./backend-program`, and uses these ctx members:
  `typeSizeOf`, `dropImpls`, `structLayouts`, `mlirEnumLayout`, `hasStringType`,
  `hasVecType`.
- Follow-ups in the same commit: delete `glueHelpers` (5856-5857); `src/mlir-glue.ts:32`
  imports `MlirUnsupported`, `MlirEmitCtx`, `stripRefs`, `typeKey`, `quote`,
  `placeType`, `refOf` from `./mlir-types` and its ~30 `glueHelpers.x` / `h.x` uses
  become plain calls; `src/mlir-ctx.ts:12` imports `MlirEmitCtx` from `./mlir-types`;
  `src/mlir-backend.ts:14` takes `typeAliasText` from `./mlir-types`. [code] These three
  are the only importers of emit-mlir.ts in src, tests and scripts. After this, mlir-glue.ts
  no longer imports emit-mlir.ts.
- Watch: `src/mlir-llvm.ts` also exports a `PTR`. No file imports both today [code:
  scaffold.ts takes it from mlir-llvm, emit-mlir.ts has its own].
- Gate filters: `match`, `hashMap`, `closure`, `Drop`.
- Expected: emit-mlir.ts 5939 -> ~5400; new file ~550 lines; exports +27, -1
  (`glueHelpers`); ts-portable sum over emit-mlir + mlir-types + mlir-glue unchanged
  apart from the `glueHelpers` object literal going away.
- Commit: `move mlir type and place helpers out of emit-mlir into mlir-types`

## E2: module tail -> src/mlir-backend.ts

- Move `constAttr`, `globalOps`, `itableOps`, `mlirModuleText` (5889-5939, 51 lines)
  into `src/mlir-backend.ts` as unexported functions. [code] mlir-backend.ts is their
  only importer.
- `MlirFunction` and `emitMlirFunction` stay in emit-mlir.ts.
- Interface: none new. mlir-backend.ts adds imports of `placeType`, `placeBlocker`,
  `quote`, `MlirUnsupported` from `./mlir-types` plus whatever tsc reports missing
  (`globalInit`/`ConstVal` from `./const-fold` if `constAttr` uses them).
- Gate filters: `global` (17 fixtures), `trait` (9), `Trait`, `match`.
- Expected: emit-mlir.ts ~5400 -> ~5350; mlir-backend.ts 278 -> ~329; exports -3.
- Commit: `move module text assembly from emit-mlir into mlir-backend`

## E3: match -> src/mlir-emit-match.ts

- Methods (10, 475 lines): `eq` 4144-4147, `armRun` 4149-4153, `match` 4217-4430,
  `armBinder` 4432-4459, `enumLayout` 4461-4466, `leaksUnbound` 4468-4472,
  `nestedMatch` 4474-4575, `bindPaths` 4577-4647, `literalChain` 4806-4835,
  `borrowedString` 5719-5728.
- Top-level moved along (21 lines, used only here): `patLiteral` 537-551, `ArmBinder`
  646-649, `MatchOuter` 650-651.
- Interface, the only export of the new file:

      export function match(fe: FnEmitter, m: MatchIn, resultTy: string | null,
                            armBody?: (body: Stmt[]) => boolean): { done: boolean; v: Val }

- Host callers to rewrite (11): `into`, `combinatorMatch`, `stmtCore`, `ifLet`,
  `letElse`, `exprStmt`, `exprAt`, `propagate`, `resultContext`, `defaultValue`,
  `forIterator`.
- Export from emit-mlir.ts: `FnEmitter`, and the types `MatchIn`, `Val`, `Binding`,
  `ArmBody`, `X`.
- Host members that lose `private` (32): methods `peek`, `emit`, `f`, `ty`, `hasDrop`,
  `value`, `lookup`, `bigSlot`, `fieldPlace`, `def`, `expr`, `tempSlot`, `k`, `borrow`,
  `place$`, `fresh`, `region`, `bind`, `synIdent`, `binop`, `ownedSlot`, `cloneTo`,
  `syn`, `tail`, `stmts`; fields `scopes`, `blocks`, `cx`, `clones`, `vars`, `n`, `fx`.
- [run] Host fields the cluster assigns: `vars`, `n`. Ctx members used: `mlirEnumLayout`.
- Gate filters: `match`, `enum`, `ifLet`, `letElse`, `option`.
- Expected: emit-mlir.ts ~5350 -> ~4855; new file ~505 lines; exports +38 and
  `FnEmitter`.
- Commit: `move match emission out of FnEmitter into mlir-emit-match`

## E4: for loops -> src/mlir-emit-for.ts

- Methods (11, 456 lines): `loopBody` 1924-1928, `forIn` 2363-2408, `forEach`
  2410-2453, `forRange` 2455-2483, `mapForEach` 2568-2647, `forStrView` 2649-2696,
  `consumedArrayForEach` 2698-2739, `arrayForEach` 2741-2784, `consumedForEach`
  2786-2852, `callHelper` 4837-4846, `forIterator` 4929-4969.
- Top-level moved along: `ForEachS` 633-641.
- Interface: `export function forIn(fe: FnEmitter, s: Stmt & { kind: "ForInStmt" }): boolean`.
  One host caller: `stmtCore`.
- Imports `match` from `./mlir-emit-match` (`forIterator` calls it).
- Host members that lose `private` (17): methods `vecPlace`, `loc`, `closeScope`,
  `runsUserDrop`, `into`, `consume`, `letStmt`, `arg`, `stmtCore`, `place`,
  `contractCheck`; fields `loops`, `loopBase`, `pending`, `body`, `owned`, `bitCopies`.
- [run] Host fields assigned: `loops`, `loopBase`, `scopes`, `blocks`, `owned`, `vars`,
  `callees`. Ctx members: `mapSlotLayout`, `mlirEnumLayout`, `mlirStrViewStep`,
  `contractChecks`.
- Gate filters: `forIn`, `for`, `vec`, `hashMap`, `iter`, `range`.
- Expected: emit-mlir.ts ~4855 -> ~4390; new file ~475 lines; exports +18.
- Commit: `move for-loop emission out of FnEmitter into mlir-emit-for`

## E5: calls and builtins -> src/mlir-emit-call.ts

- Methods (10, 397 lines): `libcCall` 1603-1616, `print` 5218-5233, `printText`
  5235-5256, `nativeBuiltin` 5258-5326, `formatText` 5328-5359, `todo` 5386-5399,
  `nativeFfi` 5402-5495, `ffiCall` 5497-5501, `assert` 5503-5519, `call` 5740-5853.
- Top-level moved along: `NATIVE_BUILTINS` (nothing, if N1 landed first).
- Interface:

      export function call(fe: FnEmitter, e: FormOf<"Call">, stmt: boolean,
                           into?: string, abi = false): Val

  Two host callers: `into`, `exprAt`. The synthesized calls in `cloneCall` (1307) go
  through `call` as well; check it with tsc after the move.
- Host members that lose `private` (17): methods `lent`, `decay`, `fieldValue`, `take`,
  `pend`, `operand`, `ownedLocal`, `rtCall`, `helperOperand`, `valued`, `panicAt`,
  `constTrue`, `panicText`, `site`, `appendText`; fields `fns`, `fn`.
- [run] Host fields assigned: `pending`, `vars`, `callees`, `calls` (`calls` is written
  nowhere else). Ctx members: `isBuiltinName`, `fnSigs`, `sretFns`, `llvmType`,
  `mlirClosureParamEscapes`, `mlirCAbiShim`, `retainingLibc`, `mlirAtomic`,
  `mlirProcessGlobal`, `mlirOutWrite`.
- Gate filters: `extern`, `print`, `closure`, `atomic`, `assert`, `generic`.
- Expected: emit-mlir.ts ~4390 -> ~3990; new file ~410 lines; exports +18.
- Commit: `move call and builtin emission out of FnEmitter into mlir-emit-call`

## E6: statements -> src/mlir-emit-stmt.ts

- Methods (12, 344 lines): `stmt` 1893-1900, `isMatchStmt` 1906-1911, `stmtAt`
  1913-1922, `stmtCore` 1930-2005, `ifStmt` 2007-2019, `ifLet` 2021-2028, `ifChain`
  2030-2069, `letElse` 2072-2105, `nullRefUnwrap` 2107-2120, `letStmt` 2122-2180,
  `returnStmt` 2277-2307, `exprStmt` 2309-2353. The field `chains` (2070) is used only
  by `ifChain`; it stays a field of `FnEmitter` and becomes public.
- Interface (three exports):

      export function stmt(fe: FnEmitter, s: Stmt): boolean
      export function stmtCore(fe: FnEmitter, s: Stmt): boolean
      export function letStmt(fe: FnEmitter, name: string, value: X, mutable: boolean,
                              viewLet: boolean, _span?: Span): boolean

  Host callers: `stmt` from `stmts`, `tail`, `tailInto`; `stmtCore` and `letStmt` from
  `forIterator`, which E4 moved, so `src/mlir-emit-for.ts` changes `fe.stmtCore(` and
  `fe.letStmt(` to the imported functions. This file imports `forIn` from
  `./mlir-emit-for` and `match` from `./mlir-emit-match`.
- Host members that lose `private` (19 plus `chains`): methods `at`, `lazyGuards`,
  `assign`, `scoped`, `dropPending`, `isSretCall`, `matchOf`, `diverges`, `ret`,
  `retMain`, `elemRef`, `debugVar`, `debugValue`; fields `sretOut`, `isMain`, `retTy`,
  `retView`, `keyBody`, `retPlaceOnly`.
- Gate filters: `match`, `forIn`, `Drop`, `ifLet`, `letElse`, `return`, `while`.
- Expected: emit-mlir.ts ~3990 -> ~3650; new file ~355 lines; exports +22.
- Commit: `move statement emission out of FnEmitter into mlir-emit-stmt`

---

# Plan B: emit derived Clone instances on demand

## Claim check

Claim: "since 83608f73 the emitter emits a derived Clone instance for every type
whether or not anything calls it."

- Eager emission: **confirmed**. [code] `MlirPlan.functions()` (`src/mlir-backend.ts:198`)
  emits every non-extern function of `prog.functions` plus `cx.plan.initFns`, with no
  reachability filter. [run] A fixture with two structs and no clone call
  (`struct Inner { name: string, xs: Vec<i32> }`, `struct Outer { a: Option<Heap<Inner>>, b: Vec<Inner>, n: i32 }`,
  a `main` that builds one of each; `bun src/main.ts emit-mlir two.milo --all`) gives 340,688 bytes and
  198 `func.func`, among them `Inner$Clone$clone`, `Outer$Clone$clone`,
  `Option_Heap_Inner$Clone$clone`, the prelude's `ErrorMessage$Clone$clone` and
  `Unit$Clone$clone`, plus `Vec_i32$clone`, `Vec_Inner$clone`, `string$clone` and their
  clone glue.
- "Since 83608f73": **refuted as worded**. [code] Auto-derive for every eligible plain
  struct and enum dates from 7a3344b4 (2026-09-20), and emission was always eager.
  83608f73 only touched `src/checker-derive.ts` and widened eligibility
  (`Option<Heap<T>>`, Vec of Heap-holding elements). That made the type-size test's
  structs eligible, which is what moved the number.
- Size: [run] 15,834 bytes per type pair today = derived Clone 6,238 (3 functions) +
  `Vec_T$clone` 1,106 (2 functions) + clone glue 6,275 (7 functions) + drop glue 1,823 +
  type aliases 392. The earlier 8.3 KB figure comes from the test's comment and commit
  6c6a75c2 and was [not verified] by re-running the old commit.

## What lazy emission buys (simulation)

[run] A throwaway probe emitted the module, drops demand-only functions nothing refers to
(transitively), and reports bytes and dangling references. Module text only: the
filtered modules were not linked or executed.

| stage | demand-only set | bytes per pair | 24 pairs | functions skipped |
|---|---|---|---|---|
| today | none | 15,834 | | 0 |
| 1 | derived Clone | 9,596 | 556,750 | 74 |
| 2 | stage 1 + generic instances + builtin-container inherent method instances | 2,014 | 371,180 | 124 |

Stage 1 lands at 9.6 KB, not 8.3 KB, because `Vec_T$clone` and the clone glue it asks
for (7.4 KB) stay. Stage 2 removes them. two.milo: 340,688 -> 335,507 (stage 1, 5
skipped) -> 326,895 (stage 2). [run] On all 28 `*[Cc]lone*` fixtures plus
`mlir/test/programs/clone-glue.milo`: 0 dangling references, and derived clones that are
called stay.

## Design

**Where the worklist lives:** in `MlirPlan.functions()`. It is the one place that
decides which functions get emitted, and it already holds what the worklist needs.

**What is demand-only:** a new `BackendProgram.demandOnly: ReadonlySet<string>` filled
by the checker. Stage 1: the names `DeriveSynth` registers for a derived Clone impl
(including `deriveCloneForBuiltinInstance`). Hand-written `impl Clone` is not in the
set. Stage 2 adds functions for which the checker's `isGenericInstance` is true or
whose owner is in `containerSelfType`, with no trait impl and no `@externalLinkage`.

**Roots:** every function not in `demandOnly`, `cx.plan.initFns`, and every name in
`prog.itables[].methods` (a trait object can call a method with no direct call anywhere).

**Edges:** `MlirFunction.callees` of each emitted function, plus `glue.callees`.
[code] `callees` is what `mlirModuleText` already uses to print declarations, closure
bodies merge their callees into the parent (emit-mlir.ts 3714, ~3845), and the calls
the emitter makes up itself (`cloneCall` at 1307 for array repeat) go through `call`
and land in `callees`. That is why the worklist runs at emission time and not as a
pre-pass over the AST or over `prog.callees`: neither sees emitter-made calls.

**Algorithm:**

    all = non-extern prog.functions ++ cx.plan.initFns      // as today
    cx.planAttributes(all)                                   // unchanged: whole list, before any body
    wanted = set of itable method names
    repeat
      for i in 0 .. all.length-1, in order:
        skip if emitted[i], or (demandOnly has all[i].name and wanted lacks it)
        emitted[i] = emitMlirFunction(all[i], ...); add its callees to wanted
      add glue.callees to wanted
    until a full pass emits nothing
    return emitted functions in index order

`itableOps` and `glue.module()` then run as today. The glue step is a safety net:
[code] glue (`milo.clone.*`, `milo.drop.*`) is already generated on request and today
never calls a derived `T$Clone$clone`, but keeping it in the loop means a later glue
change cannot leave a reference with no definition.

**How demand spreads:**
- Direct `x.clone()`: the checker resolves it to `T$Clone$clone`; `call` records it.
- Generic code with `T: Clone`: the monomorphized instance calls `T$Clone$clone`
  directly; the edge is recorded when that instance is emitted. In stage 2 the instance
  itself is demand-only and is reached the same way from its caller.
- A derived Clone of a struct calls the Clone of each field type; those are found when
  the struct's Clone is emitted, in a later pass.
- Trait objects: itable methods are roots, so anything a `dyn` call can reach is emitted.
- Closures capturing by clone: [code] `cloneTo` goes to `glue.cloneFromPlace`, which is
  structural glue with no edge to a derived Clone.
- Std collections: `Vec_T$clone` asks for clone glue; in stage 1 it is a root, in
  stage 2 it is demand-only and reached from whoever calls it.
- Function values: [code] `fnAddress` (emit-mlir.ts 2551) emits `milo.fn.addr @name`
  and does **not** add the name to `callees`. This must be fixed first (commit B1), or
  a function only ever taken by address would be skipped.

**Compilation units:** [code] `src/cgu.ts` splits one finished LLVM module after
monomorphization, and non-root functions have internal linkage. One MLIR module holds
the whole program, so no unit can need an instance another unit skipped. cgu.ts needs
no change; it sees fewer functions.

**Determinism:** pass order is `prog.functions` order, every container is
insertion-ordered, and the result is returned in index order, so function order equals
today's minus the skipped ones. Glue and alias order is first-request order, and a
function emitted in a later pass requests its glue later than today. So the text is not
"today's text with deletions", and `ir-same` cannot gate commits B3 and B4. Gate
determinism by emitting the same fixture twice and comparing bytes.

**Failure mode:** [code] `mlirModuleText` declares every callee that has no definition,
so a skipped function that is referenced through `callees` fails at link, and a
reference missing from `callees` fails MLIR verification. Both are loud.

## Risks

1. `tests/traceObject.test.ts:79` asserts the binary contains `ErrorMessage$Clone$clone`
   [code]. It must change in B3.
2. Interpreter-vs-binary comparison: not affected. [code] `src/interp.ts:65` loads
   `cr.monomorphizedFns` from the check result, not from emitted functions.
3. Drop/clone pairs: not coupled. [code] Drop is glue or a hand-written `T$Drop$drop`
   (a trait impl, so a root); clone glue and drop glue are requested independently.
4. `scripts/mlir-same.ts` counts coverage from `MILO_MLIR_LOG` lines [code], so skipped
   functions leave both numerator and denominator. An instance the emitter cannot
   handle but nothing reaches no longer fails the build, which hides a coverage gap.
   Keep an env switch (`MILO_MLIR_EAGER=1`) that restores eager emission for the
   coverage run.
5. `emit-mlir` without `--all` (`functionTexts`, mlir-backend.ts:222) stops printing
   unreached derived clones; goldens that contain them need regenerating in B3.
   [not verified] how many goldens.
6. Hot reload: [code] `src/hot.ts` restarts when the function set changes, so the first
   `.clone()` on a type becomes a restart instead of a patch.
7. Names looked up by string outside the emitter (`Task$spawnWithStack` in
   `src/startup.ts`, `replayHeapMalloc/Realloc/Free` in `mlir/Link.cpp`) are plain
   functions and stay roots [code]. Stage 2 must keep `@externalLinkage` and anything
   named by scaffold out of the set.
8. Other non-call symbol references (`milo.closure @name` 3716, env-drop `fn.addr`
   3824/3864, `via @glue` 5353, `milo.ccall` 5491) name closures, glue or C symbols, not
   module functions [code]. B1's check is what proves there is no further gap.

## Commits

Each is one bounded commit. Never run the oracle script without `--filter`.

**B1. Record function-address edges.**
- `fnAddress` adds `op.name` (with its type text, as `call` does) to `this.callees`.
- New test `tests/mlirCalleeEdges.test.ts`: for about ten named fixtures (closures,
  function values, trait objects, generics), every `@name` in a function's text that
  names a module function is that function, one of its closures, or a key of its
  `callees`.
- Gate: the new test fails before the `fnAddress` change and passes after;
  `bun scripts/ir-same.ts --emit mlir --base HEAD --filter closure` and `--filter fn`
  byte-identical except added `func.func private` declarations (expect none, since
  the functions are defined in the module).
- Commit: `record fn-address references in mlir callees`

**B2. Checker marks derived Clone; plumb `demandOnly`. No behaviour change.**
- `DeriveSynth` records each derived Clone function name; `CheckResult` and
  `BackendProgram` carry `demandOnly`. Nothing reads it yet.
- Gate: unit test on the two-struct fixture: set holds `Inner$Clone$clone`,
  `Outer$Clone$clone`, `Option_Heap_Inner$Clone$clone`; for
  `cloneDeriveEnumHandWritten` the hand-written impl is absent from the set.
  `bun scripts/ir-same.ts --emit mlir --base HEAD --filter lone` byte-identical.
- Commit: `mark derived clone functions as demand-only in backend program`

**B3. Worklist in `MlirPlan.functions()` (stage 1).**
- Implement the algorithm above; `MILO_MLIR_EAGER=1` keeps the old behaviour.
- Update `tests/traceObject.test.ts:79`, regenerate affected goldens, update
  `docs/mlir-backend.md`.
- New test: no clone call gives zero `$Clone$clone` definitions outside the prelude's
  reachable ones; one `o.clone()` on `Outer` gives exactly `Outer`, `Inner` and
  `Option_Heap_Inner`.
- Gate: `tests/emitMlirTypeSize.test.ts` reports about 9.6 KB per pair; tighten its
  bound from `20_000` to `12_000`. `bun scripts/mlir-same.ts --filter '[Cc]lone' --jobs 2`
  and `bun scripts/mlir-same.ts --programs --owned --filter clone` green. Emit
  `cloneDeriveMutualRecursion` twice and `cmp` the outputs. Full suite in the background.
- Commit: `emit derived clone functions only when referenced`

**B4. Stage 2: generic and container-method instances.**
- Checker adds to `demandOnly` every function with `isGenericInstance` true or owner in
  `containerSelfType`, excluding trait impls and `@externalLinkage`.
- Gate: type-size about 2.0 KB per pair; bound to `4_000`. Oracle script with
  `--filter 'generic|Generic'` (40 fixtures), `--filter 'closure|Closure'` (53),
  `--filter 'dyn|[Tt]rait'` (14), `--filter '[Cc]lone'` (28). Emit twice and `cmp`.
  Full suite in the background.
- Commit: `emit generic and container method instances only when referenced`

Clone-heavy fixtures the `[Cc]lone` filter covers [run]: cloneDeriveCrossModuleOptionVec,
cloneDeriveEnumExplicit, cloneDeriveEnumHandWritten, cloneDeriveEnumInStruct,
cloneDeriveEnumPayload, cloneDeriveEnumRecursive, cloneDeriveExplicitOverAuto,
cloneDeriveHeapNested, cloneDeriveMutualRecursion, cloneDeriveOption,
cloneDeriveOptionLate, cloneOfTempDrop, cloneOptionOfMethodClone, deriveCloneAuto,
dropRunsAfterFieldClone, fieldCloneOutOfContainer, hashMapCloneDeep, hashmapCloneNested,
hashMapCloneStd, indexCloneNoLeak, structCloneOutOfContainer, vecClone, vecCloneStd,
arrayRepeatDropClone, array_index_clone, sliceCloneReassign, strCloneWithCapacityStd,
lintBorrowThatClones; plus `mlir/test/programs/clone-glue.milo` under `--programs`.

## Open questions

1. Is a restart on the first `.clone()` of a type acceptable for hot reload, or should
   hot mode set `MILO_MLIR_EAGER`?
2. Should the coverage run stay eager, so unreached instances the emitter cannot handle
   keep failing?
3. Class clusters as free functions over `fe: FnEmitter` make about 85 members public.
   Acceptable, or cut `exprAt` into per-form functions first and re-measure?
