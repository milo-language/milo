# Splitting src/checker.ts: measured seams and the first 8 extractions

Status: plan only, nothing moved yet. Measured 2026-11-09 at commit bb702f49,
`src/checker.ts` = 15833 lines (one `TypeChecker` class with 428 methods and 186
fields, plus 73 top-level declarations).

Line spans below are from that commit and will drift. Briefs name every method, so
move by name and re-run the script (`member <names>`) for current spans.

## How it was measured

Script (TypeScript compiler API, about 17 s per run, run from the repo root):

    bun scripts/checker-seam.ts . members                          # every decl and member: span, fan-in, state read/written
    bun scripts/checker-seam.ts . member <name...>                 # one member: calls, fields, referrers (top-level: ::name)
    bun scripts/checker-seam.ts . fields                           # every field: readers, writers, node-keyed or not
    bun scripts/checker-seam.ts . free                             # per-method purity tier
    bun scripts/checker-seam.ts . clusters scripts/checker-clusters.json   # the table below
    bun scripts/checker-seam.ts . cluster  scripts/checker-clusters.json <cluster...>   # members, entries, host list for a brief

Re-run it after checker.ts changes: spans and counts drift.

What the script records per member: line span (leading comment included), calls to
other members (including `TypeChecker.X` statics), `this.<field>` reads, writes
(assignment) and in-place changes (traced back through locals, loop variables and
`.get()` results to the field they came from), top-level declarations used, and the
ts2milo violation count (`violationsOf` from `scripts/ts2milo/subset.ts`).

A cluster is a seed list grown by absorbing private members whose referrers are all
inside it. Its cost, the "new exports" column, is everything that has to cross the cut:

    host methods called + host fields read + host fields written
    + entry points the rest of checker.ts calls
    + top-level declarations that must become exported

"Writes reachable" counts checker fields (other than `diagnostics` / `firedWarnings`)
that the cluster can write directly or through the host methods it calls. 135 or more
means the cluster re-enters `checkExpr`.

Purity tiers over all 428 methods (transitive through the call graph):

| tier | methods | lines |
|---|---|---|
| A: no checker state | 57 | 770 |
| A*: no checker state, changes an argument in place | 4 | 38 |
| B: reads fields only | 76 | 1108 |
| B*: reads fields, changes a shared record in place (mostly `Set<string>` recursion guards) | 16 | 427 |
| C: reads fields and reports diagnostics | 42 | 1012 |
| D: writes checker fields | 233 | 10680 |

So about two thirds of the file sits in methods that write shared state, and four
methods hold 3618 lines by themselves: `checkMethodCallExprInner` 1376, `checkProgram`
806, `checkStmtBody` 725, `checkCallExpr` 711.

## Measured table

Sorted by new exports per 100 lines moved (lower is cheaper). Each row is measured as if
it were the only extraction. The first 12 rows do not overlap each other. Further down,
rows share private helpers (the script prints the overlaps on stderr), which is itself a
finding: see "Do not split yet".

| cluster | lines | methods | owned fields | host methods | fields read | fields written | entries | top-level exports | new exports | exports / 100 lines | writes reachable (non-diagnostic) | ts2milo violations | pure pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| global-init-order | 112 | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 2 | 1.8 | 0 | 48 | yes |
| module-predicates | 95 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 3 | 3.2 | 0 | 8 | yes |
| const-eval | 162 | 10 | 0 | 0 | 0 | 0 | 7 | 0 | 7 | 4.3 | 0 | 49 | yes |
| control-flow | 173 | 9 | 3 | 3 | 1 | 0 | 4 | 0 | 8 | 4.6 | 0 | 65 | yes |
| tails | 149 | 9 | 0 | 1 | 0 | 0 | 6 | 0 | 7 | 4.7 | 0 | 89 | yes |
| builtin-decls | 126 | 3 | 0 | 0 | 0 | 3 | 3 | 0 | 6 | 4.8 | 3 | 26 | no |
| arena-lint | 60 | 1 | 0 | 1 | 1 | 0 | 1 | 0 | 3 | 5.0 | 0 | 36 | yes |
| attr-validation | 168 | 6 | 1 | 2 | 1 | 0 | 6 | 1 | 10 | 6.0 | 0 | 45 | yes |
| type-subst | 112 | 7 | 0 | 0 | 0 | 0 | 6 | 1 | 7 | 6.3 | 0 | 62 | yes |
| ffi-c-abi | 325 | 13 | 5 | 4 | 2 | 4 | 11 | 0 | 21 | 6.5 | 5 | 105 | no |
| type-facts | 522 | 32 | 2 | 0 | 8 | 1 | 26 | 0 | 35 | 6.7 | 1 | 202 | no |
| types | 419 | 0 | 0 | 0 | 0 | 0 | 29 | 0 | 29 | 6.9 | 0 | 17 | yes |
| expr-method-call | 1390 | 2 | 0 | 69 | 12 | 14 | 2 | 3 | 100 | 7.2 | 136 | 258 | no |
| process-derives | 180 | 1 | 0 | 3 | 3 | 6 | 1 | 0 | 13 | 7.2 | 28 | 40 | no |
| pattern-space | 204 | 8 | 0 | 6 | 1 | 1 | 6 | 1 | 15 | 7.4 | 1 | 114 | no |
| monomorphize | 670 | 13 | 7 | 18 | 14 | 11 | 8 | 4 | 55 | 8.2 | 130 | 221 | no |
| register-impl | 303 | 3 | 0 | 6 | 6 | 10 | 1 | 3 | 26 | 8.6 | 22 | 84 | no |
| raw-type-param-reads | 69 | 1 | 0 | 2 | 3 | 0 | 1 | 0 | 6 | 8.7 | 0 | 55 | yes |
| call-exclusivity | 382 | 15 | 1 | 19 | 8 | 1 | 5 | 2 | 35 | 9.2 | 7 | 145 | no |
| field-defaults | 137 | 6 | 2 | 6 | 3 | 1 | 3 | 1 | 14 | 10.2 | 136 | 82 | no |
| expr-call | 711 | 1 | 0 | 49 | 9 | 12 | 1 | 2 | 73 | 10.3 | 136 | 152 | no |
| generic-static-infer | 185 | 3 | 0 | 8 | 6 | 2 | 3 | 1 | 20 | 10.8 | 136 | 47 | no |
| moves | 442 | 18 | 0 | 25 | 7 | 7 | 6 | 3 | 48 | 10.9 | 14 | 56 | no |
| callback-coercion | 146 | 6 | 0 | 9 | 1 | 0 | 4 | 2 | 16 | 11.0 | 25 | 23 | reads only, host calls write 25 |
| const-retype | 82 | 3 | 0 | 3 | 1 | 1 | 3 | 1 | 9 | 11.0 | 136 | 25 | no |
| places | 618 | 37 | 2 | 19 | 4 | 8 | 33 | 6 | 70 | 11.3 | 18 | 173 | no |
| place-algebra | 194 | 17 | 0 | 0 | 0 | 0 | 17 | 5 | 22 | 11.3 | 0 | 102 | yes |
| check-program | 806 | 1 | 0 | 48 | 6 | 30 | 1 | 7 | 92 | 11.4 | 168 | 117 | no |
| name-hints | 217 | 9 | 0 | 1 | 13 | 2 | 8 | 1 | 25 | 11.5 | 1 | 188 | no |
| json-index-rewrite | 78 | 3 | 0 | 5 | 0 | 1 | 2 | 1 | 9 | 11.5 | 136 | 25 | no |
| sql-glue | 79 | 7 | 2 | 3 | 3 | 1 | 3 | 0 | 10 | 12.7 | 2 | 41 | no |
| expr-enum-struct-lit | 476 | 7 | 0 | 33 | 14 | 9 | 4 | 2 | 62 | 13.0 | 136 | 83 | no |
| contracts | 150 | 7 | 1 | 10 | 2 | 2 | 6 | 0 | 20 | 13.3 | 135 | 80 | no |
| lints | 127 | 6 | 1 | 6 | 5 | 0 | 5 | 1 | 17 | 13.4 | 2 | 52 | reads only, host calls write 2 |
| map-intrinsics | 102 | 5 | 0 | 7 | 1 | 1 | 4 | 1 | 14 | 13.7 | 136 | 46 | no |
| borrows | 272 | 22 | 0 | 10 | 4 | 1 | 19 | 4 | 38 | 14.0 | 2 | 74 | no |
| stmt-body | 764 | 3 | 0 | 85 | 11 | 14 | 1 | 2 | 113 | 14.8 | 136 | 196 | no |
| move-state | 135 | 13 | 2 | 5 | 2 | 4 | 9 | 2 | 22 | 16.3 | 5 | 65 | no |
| view-provenance | 233 | 12 | 0 | 23 | 4 | 6 | 7 | 0 | 40 | 17.2 | 137 | 82 | no |
| vec-infer | 82 | 6 | 0 | 3 | 2 | 5 | 5 | 0 | 15 | 18.3 | 136 | 49 | no |
| match-check | 250 | 3 | 0 | 32 | 2 | 6 | 2 | 4 | 46 | 18.4 | 136 | 54 | no |
| unsafe-extern-notes | 157 | 10 | 0 | 4 | 14 | 2 | 10 | 1 | 31 | 19.7 | 2 | 38 | no |
| view-binds | 106 | 4 | 0 | 4 | 13 | 2 | 2 | 0 | 21 | 19.8 | 5 | 96 | no |
| std-method-dispatch | 262 | 10 | 1 | 32 | 9 | 2 | 10 | 2 | 55 | 21.0 | 135 | 67 | no |
| option-result-conv | 57 | 4 | 0 | 5 | 4 | 0 | 4 | 0 | 13 | 22.8 | 22 | 20 | reads only, host calls write 22 |
| flex-int | 21 | 2 | 0 | 3 | 0 | 0 | 2 | 1 | 6 | 28.6 | 136 | 3 | reads only, host calls write 136 |
| program-view | 98 | 3 | 0 | 12 | 21 | 1 | 3 | 0 | 37 | 37.8 | 0 | 39 | yes |

Column notes: "pure pass" = yes when the cluster writes no checker field, so it can take
a captured input and return findings. "Pure" is not the same as "portable through
ts2milo today": most of these walk the AST as `unknown` / `Record<string, any>`
(that is where their violations come from) and need a generated typed walker
(`src/ast-walk-*.ts`) to pass `scripts/ts-portable.ts`. Moving them does not lower the
violation total. It puts each walk in a small file where the conversion can be done and
counted one at a time, which is the Stage 4 rule in docs/plans/ts2milo.md (effort
counted net over pass + host + what is left behind).

## Recommended order of the first 8

By rank, with two adjustments for dependencies: `types` is pulled ahead of its rank
(6.9) because every later host interface has to name `VarInfo`, `TraitInfo`,
`GenericEnumInfo`, `BorrowSite`, `PatternLeaf` and friends, and `builtin-decls` goes
after it for that reason.

| # | cluster | lines | new exports | checker.ts after (approx) |
|---|---|---|---|---|
| 1 | global-init-order | 112 | 2 | 15727 |
| 2 | module-predicates | 95 | 3 | 15634 |
| 3 | const-eval | 162 | 7 | 15473 |
| 4 | tails (needs 3) | 149 | 6 | 15325 |
| 5 | control-flow | 173 | 8 | 15160 |
| 6 | arena-lint (needs 2) | 60 | 1 | 15101 |
| 7 | types | 419 | 29 names, 0 accessors | 14685 |
| 8 | builtin-decls (needs 7) | 126 | 6 | 14560 |

Then, same method, in this order: attr-validation, type-subst, type-facts, ffi-c-abi
(sketched after the briefs). Those 12 together move about 2420 lines and leave
checker.ts near 13.4k. Moving code alone stalls there. Everything below that needs one
of the redesigns listed under "Do not split yet".

## Rules for every extraction

Invariants:

- No behavior change. Diagnostics are byte-identical: same messages, spans, hints,
  codes, notes, and the same order.
- Move bodies verbatim, with their comment blocks. The only edits allowed inside a moved
  body are dropping `this.` on calls that became free functions and replacing `this.x`
  with the host or parameter named in the brief. No renames, no rewording, no cleanups.
- A new file never imports a value from `./checker` (types only, via `import type`).
  The existing hosts get away with value imports only because they use them inside
  function bodies; do not add more.
- Call-site rewrites are mechanical (`this.name(` to `name(` or `this.flow.name(`). Do
  them with a small bun script over the exact method names. tsc is the gate that cannot
  be gamed here: a missed site is a compile error because the method no longer exists.
- One extraction per commit, in its own worktree, rebased on trunk first (checker.ts
  is under active edit).

Gate, in this order (each step is seconds, except the last block):

    bunx tsc --noEmit -p . | grep -E "^(scripts|src|tests)/"        # must print nothing
    bun test tests/<named in the brief>
    bun scripts/ir-same.ts --emit check --base HEAD --filter <named in the brief>   # check --json byte-identical
    bun scripts/file-size-ratchet.ts          # must not say "grew"; if it says "shrank", run it with --update
    bun scripts/ts-portable.ts --check        # only complaint allowed: "<new file>: not in baseline"
    bun scripts/ts-portable.ts --write        # then read the diff: checker.ts drops by at least what the new file gains

    # background, never blocking the commit; fix forward if red
    bun scripts/ir-same.ts --emit check --base HEAD~1
    bun scripts/ir-same.ts --emit mlir  --base HEAD~1
    bun run scripts/run-examples.ts           # AGENTS.md rule for checker.ts changes
    bun test tests/ts2milo.test.ts

The ratchet baseline (`tests/file-size-baseline.json`) holds `src/checker.ts: 15833` and
goes red once the file is 200 lines under it without an update. Extractions 1 and 2
together shrink it by about 200, so the plain run turns red at the second or third
commit. Simplest: run `--update` in every extraction commit, after the plain run showed
no "grew" line, and commit the baseline with the move.

Optional faster oracle (in-process, no build): `bun scripts/checker-diag-snapshot.ts . out.json
[--only tests/errors]` writes every diagnostic of every `tests/errors` and
`tests/fixtures` program to one JSON file; run it before and after and `cmp` the two.
Measured 0.1 to 0.17 CPU seconds per program.

## Briefs

### 1. global-init-order

- Move: `orderGlobalsByDependency` (7854-7965, comment block included).
- To: `src/checker-global-order.ts`.
- Interface:

      export interface GlobalInitOrder { order: GlobalDecl[]; selfDependent: GlobalDecl[] }
      // null when there are fewer than two globals. Does not change `program`.
      export function globalInitOrder(program: Program): GlobalInitOrder | null

  `selfDependent` is the old `onDirectCycle` set in its insertion order. The call site
  in `checkProgram` (line 4606) reports the error for each entry (message and hint text
  unchanged, span `g.span`), then replaces the contents of `program.globals` in place
  (`length = 0; push(...order)`), as the method does today. In place matters: other code
  holds that array.
- Invariant specific to this one: errors are reported before the reorder, in set order.
- Test: `MILO_TEST_FILTER='globalInit|lazyGlobal' bun test tests/run.test.ts`
  (tests/errors/globalInitCycle.milo, tests/fixtures/globalInitOrder.milo).
  ir-same filter: `lobalInit`.
- Number: checker.ts 15833 -> about 15727. Exports added = 2 (function, result type).
  Host accessors = 0.
- Commit: `extract global init ordering into checker-global-order.ts`

### 2. module-predicates

- Move (top-level): `RAW_SLICE_INTRINSICS` 56, `ADOPT_INTRINSICS` 57-60,
  `FOREIGN_MODULE` 61, `inModule` 63-74, `displayPath` 76-84, `importPathFrom` 86-99,
  `MAP_INTRINSICS` 149-151, `isHashMapModule` 152-156, `VEC_INTRINSICS` 158-167,
  `isVecModule` 168-172, `STR_INTRINSICS` 174-181, `isStringModule` 182-186,
  `VEC_CALLBACK_METHODS` 188-189, `STD_COLLECTION_MODULES` 191-194,
  `isStdCollectionModule` 195-199, `isForeignModule` 201-207.
- To: `src/checker-modules.ts`. It imports `sep`, `relative`, `dirname` from "path" and
  `STDLIB_DIR` from "./stdlibBundle", nothing from "./checker".
- Interface: the 12 names that are exported today stay exported. Newly exported:
  `VEC_CALLBACK_METHODS`, `displayPath`, `importPathFrom`. `STD_COLLECTION_MODULES`
  stays private to the new file.
- Importers to repoint at `./checker-modules` (no re-export from checker.ts):
  `src/checker-purity-host.ts:6`, `src/emit-forms.ts:14` (it keeps
  `userFnShadowsBuiltin` from "./checker"), `tests/foreignModuleGate.test.ts:9`.
  This removes the value import of "./checker" from a host file.
- Test: `bun test tests/foreignModuleGate.test.ts`. ir-same filter: `adopt`.
- Number: 15727 -> about 15634. Exports added = 3.
- Commit: `move std module predicates and intrinsic sets to checker-modules.ts`

### 3. const-eval

- Move: `propagateRange` 2045-2074, `foldConstInt` 2076-2091, `constIntValue`
  2093-2098, `constFloatValue` 2155-2159, `constNumericValue` 2161-2167,
  `tryEvalContractExpr` 2169-2222, `resolveNumericValue` 2224-2237,
  `contractExprToString` 2326-2337, `isConstFloatExpr` 9111-9122, `isConstIntExpr`
  9132-9137. All are tier A (no `this` state).
- Stays: `isTrivialClause` (2285-2324). It calls `lookup`, which is why it is not in
  the cluster.
- To: `src/checker-const-eval.ts`, as free functions with the same names and
  signatures.
- Interface (exported): `propagateRange`, `foldConstInt`, `constIntValue`,
  `tryEvalContractExpr`, `contractExprToString`, `isConstFloatExpr`, `isConstIntExpr`.
  Not exported: `constFloatValue`, `constNumericValue`, `resolveNumericValue`.
- Call sites to rewrite in checker.ts: 30 (`isConstIntExpr` is 21 of them).
- Test: `bun test tests/contractChecks.test.ts tests/overflowChecks.test.ts tests/rangedSoundness.test.ts`.
  ir-same filter: `ontract`.
- Number: 15634 -> about 15473. Exports added = 7. Host accessors = 0.
- Commit: `move constant folding and contract evaluation to checker-const-eval.ts`

### 4. tails (after 3)

- Move: `extractorKeys` 8431-8443, `extractorReturns` 8445-8466, `moveTargets`
  8473-8526, `tailTargets` 8528-8537, `forkHasOwnedTail` 8557-8568, `tailIsOwnedValue`
  8570-8579, `tailExprOf` 15604-15609, `flexIntLeaves` 15668-15685, `tailFlexLeaves`
  15687-15690. All tier A.
- To: `src/checker-expr-shape.ts` (questions answered from an expression's syntax
  alone), as free functions. Imports `isConstIntExpr` from "./checker-const-eval".
- Interface (exported): `extractorKeys`, `extractorReturns`, `moveTargets`,
  `forkHasOwnedTail`, `tailExprOf`, `flexIntLeaves`. Not exported: `tailTargets`,
  `tailIsOwnedValue`, `tailFlexLeaves`.
- Call sites to rewrite: 11.
- Test: `MILO_TEST_FILTER='Tail|keyExtractor|sortByKey|flexInt' bun test tests/run.test.ts`.
  ir-same filter: `Tail`.
- Number: 15473 -> about 15325. Exports added = 6. Host accessors = 0.
- Commit: `move tail and extractor shape helpers to checker-expr-shape.ts`

### 5. control-flow

- Move: `bodyAlwaysReturns` 7967-7985, field `ffiContractReported` 7987-7994,
  `lintUncheckedFfiContract` 7996-8017, `bodyEntersUnsafe` 8019-8026,
  `collectGuardNames` 8028-8041, `collectIdents` 8043-8049, `bodyNeverFallsOff`
  8051-8087, `bodyBreaksOut` 8089-8099, field `fallOffReported` 8101-8103,
  `errorIfFallsOff` 8105-8113, static `STMT_KINDS` 8130-8135 (becomes a module const),
  `scanUnreachable` 8137-8165.
- Stays (it sits in the middle of that span): `nonExhaustiveMatches`,
  `builtinFnNames`, `rawPtrBuiltinNames`, `builtinNames` (8115-8129).
- To: `src/checker-control-flow.ts`, same shape as `DeriveSynth` / `DeriveHost` in
  src/checker-derive.ts:

      export interface ControlFlowHost {
        error(msg: string, span?: Span, hint?: string): void;
        warn(code: string, msg: string, span?: Span, hint?: string, len?: number): void;
        show(t: TypeKind): string;
        // Filled by match checking in checker.ts; read here. Never reassigned, so by reference.
        nonExhaustiveMatches: WeakSet<MatchArm[]>;
      }
      export class ControlFlow {
        constructor(private host: ControlFlowHost) {}
        bodyAlwaysReturns(body: Stmt[]): boolean
        errorIfFallsOff(what: string, body: Stmt[], retType: TypeKind, span?: Span): void
        lintUncheckedFfiContract(fn: Function): void
        scanUnreachable(node: unknown): void
        // private: bodyEntersUnsafe, collectGuardNames, collectIdents, bodyNeverFallsOff,
        // bodyBreaksOut, ffiContractReported, fallOffReported
      }

  In checker.ts: `private flow = new ControlFlow({ ...explicit literal... })`, declared
  AFTER `nonExhaustiveMatches` (field initializers run in declaration order, and the
  literal reads it). Call sites become `this.flow.<name>(`: 6933, 6934, 6940, 13196 and
  the two outside callers of `bodyAlwaysReturns`.
- Test: `bun test tests/uncheckedFfiContractLint.test.ts` and
  `MILO_TEST_FILTER='unreachable|fallOffEnd' bun test tests/run.test.ts`.
  ir-same filter: `unreachable`.
- Number: 15325 -> about 15160. Exports added = 2 (class, host interface); seam
  members = 8 (4 host, 4 public methods).
- Commit: `move return and reachability checks to checker-control-flow.ts`

### 6. arena-lint (after 2)

- Move: `lintArenaNeverFrees` (5421-5480, comment block included).
- To: `src/checker-arena-lint.ts`:

      export function lintArenaNeverFrees(host: Pick<ProgramPassHost, "warn">, program: Program): void

  Imports `inModule` from "./checker-modules". `this.warn(` becomes `host.warn(`.
- The first line of the body (`if (this.warningConfig.allowed.has("arena-never-frees")) return;`)
  moves to the call site, so `ProgramPassHost` gains nothing. Line 4743 becomes
  `if (!this.warningConfig.allowed.has("arena-never-frees")) lintArenaNeverFrees(host, program);`
  right after the other whole-program passes, using the `host` already built there.
- Test: `bun test tests/arenaNeverFreesLint.test.ts`.
  ir-same filter: `rena` (the lint is on by default, so `--emit check` sees it).
- Number: 15160 -> about 15101. Exports added = 1. ProgramPassHost members added = 0.
- Commit: `move arena-never-frees lint to checker-arena-lint.ts`

### 7. types

- Move (top-level, each with its comment): `PropagateBoxing` 40-48, `BorrowKind`
  209-220, `PointerHolder` 222-225, `BorrowSite` 227-237, `PatternLeaf` 239-242,
  `PlaceStep` 244-248, `Place` 250-261, `VALUE` 263, `OPAQUE` 264, `INDEX` 265, `DEREF`
  266, `PAYLOAD` 267, `stepKey` 269-278, `stepsEq` 287-289, `stepLabel` 291-294,
  `MoveSnapshot` 296-304, `PRISTINE_MOVE` 305, `VarInfo` 307-397, `CaptureInfo` 399-425,
  `NestedWrite` 427-430, `ArgUse` 431-432, `pathsOverlap` 434-438, `FnSig` 440-450,
  `StructInfo` 484-507, `CLayout` 526-530, `CSig` 532-536, `CValue` 538-545, `EnumInfo`
  562-574, `CheckResult` 576-664, `GenericEnumInfo` 666-671, `GenericStructInfo`
  673-677, `GenericFnInfo` 679-682, `TraitMethodInfo` 684-693, `TraitInfo` 695-699,
  `ImplInfo` 701-705, `InterfaceMethodInfo` 707-710, `InterfaceInfo` 712-715, `ExprOf`
  727-729.
- Stays: every other top-level function in that range (`userFnShadowsBuiltin`,
  `rawPointerField`, `holdsRawPtr`, `replaceNode`, ...).
- To: `src/checker-types.ts`. Everything in it is exported. It imports types only, and
  nothing from "./checker" (the script found no reference from these declarations to
  anything else in checker.ts).
- Interface: checker.ts imports the names it uses (`import type` for the types, a value
  import for the 5 step constants, `PRISTINE_MOVE`, `stepKey`, `stepsEq`, `stepLabel`,
  `pathsOverlap`), and keeps the 43 files that import from "./checker" unchanged with
  one line:

      export type { PropagateBoxing, Place, CaptureInfo, FnSig, StructInfo, EnumInfo, CheckResult, ImplInfo } from "./checker-types";

  Repointing those importers is a later mechanical sweep, once checker.ts
  is quieter.
- Test: `bun test tests/typecheck.test.ts` (it is the tsc gate) and
  `bun test tests/moveOutOfBorrowSpellings.test.ts` (move tracking over every place
  spelling, which is what the moved step helpers serve).
  ir-same filter: `move`.
- Number: 15101 -> about 14685. Newly exported names = 29 (19 types, 10 values).
  Accessors = 0. Run the ratchet with `--update`.
- Commit: `move checker record types and place steps to checker-types.ts`

### 8. builtin-decls (after 7)

- Move: `registerBuiltinOption` 5007-5022, `registerBuiltinResult` 5024-5044,
  `registerBuiltinTraits` 5046-5134.
- To: `src/checker-builtin-decls.ts`, as free functions that fill the tables handed in:

      export function registerBuiltinOption(genericEnums: Map<string, GenericEnumInfo>): void
      export function registerBuiltinResult(genericEnums: Map<string, GenericEnumInfo>): void
      export function registerBuiltinTraits(traits: Map<string, TraitInfo>, traitImpls: Map<string, ImplInfo[]>): void

  Inside, `this.genericEnums` / `this.traits` / `this.traitImpls` become the parameters.
  Types come from "./checker-types". The three calls at 4067-4069 pass the fields.
- Invariant specific to this one: insertion order into the three maps is unchanged
  (later passes iterate them).
- Test: `MILO_TEST_FILTER='^(option|result|trait)' bun test tests/run.test.ts`
  (48 programs). ir-same filter: `trait`.
- Number: 14685 -> about 14560. Exports added = 3 functions; tables passed = 3.
- Commit: `move builtin option, result and trait declarations out of checker.ts`

## Next four (sketches, re-measure before briefing)

- attr-validation (168 lines, 10): `validateCopyAttr`, `validateCopyOnly`,
  `validateOrderedArgs`, `validateEnumCopyAttr`, `validateAttributes`,
  `validateFieldAttributes`, static `KNOWN_ATTRS`. Free functions over a host of
  `{ error, warn, structs }`. Needs `rawPointerField` (509-514, with `holdsRawPtr`)
  exported; it is also used by `monomorphizeStruct` and `checkProgram`.
- type-subst (112 lines, 7): `mangleTypeName`, `substituteTypeKind`, `pointeeMiloType`,
  `typeKindToMiloType`, `substituteParamType`, `substituteMiloType`,
  `substituteSelfInMiloType`. No host. `wrapTypeArg` (101-124) moves along and is
  exported because `substituteBody` also uses it.
- type-facts (522 lines, 32 methods, 35): `show`, `demangle`, `isCopyType`,
  `isAllCopyStruct`, `isAllCopyEnum`, `whyNotCopy`, `isSend`, `whyNotSend`, `isSync`,
  `carriesRawPointer`, `resourceKind`, `dropTypesIn`, `isUninhabited`, `embedsSelf`,
  `nestedRef`, `typeImplementsTrait`, `isHashable`, the Option/Result shape queries and
  the copy-out reason helpers. No host methods at all. A `TypeFacts` class that holds
  `structs`, `enums`, `traits`, `traitImpls`, `dropImpls`, `sendTypes`, `syncTypes` by
  reference, takes `handWrittenClone` as a getter (it is reassigned by
  `processDerives`), and owns the two `allCopy` memo maps. About 450 call sites, 323 of
  them `this.show(`: a script, not hand edits. Payoff beyond the line count:
  `ProgramPassHost` passes `show`, `isSend`, `whyNotSend`, `carriesRawPointer`,
  `dropTypesIn` as closures and `DeriveHost` passes four more; one `facts` field
  replaces all of them, and closures are what ts2milo cannot carry across a host.
- ffi-c-abi (325 lines, 21): `checkCSig`, `checkCValue`, `checkCLayout`,
  `checkVariadicExtern`, `warnUnverifiedExtern(Fn)`, `isValidExternStructField`,
  `thinFnField`, `checkCFnStore`, `reportStrandedCFnReads`, `isCReprFnSig`,
  `externSigError`, `isCHeaderSpec` and the five static regex / name tables. A class
  owning those tables; host `{ error, warn, show, lookup, entryFile() }` plus the tables
  `functions`, `structs`, `cSigs`, `cValues`, `strandedCFnReads`.

After `types` lands, place-algebra (194 lines, all tier A) drops from 22 to 17 exports
and pattern-space from 15 to 14; re-rank then.

## Do not split yet

1. The four giant methods (`checkMethodCallExprInner`, `checkStmtBody`,
   `checkCallExpr`, `checkProgram`; 3618 lines). Moved whole, each needs a host of 73 to
   113 members, which is the class again with `host.` in front. They have to be cut
   inside first. The seams that exist inside the method-call checker today
   (std-method-dispatch, map-intrinsics, vec-infer, callback-coercion) measure 11 to 21
   exports per 100 lines because each one calls back into `checkExpr`.
2. Anything that re-enters `checkExpr` / `checkStmt` (the rows with 135 to 137 in
   "writes reachable": the expression and statement checkers, field-defaults,
   generic-static-infer, const-retype, json-index-rewrite, contracts, view-provenance,
   match-check, flex-int). One `checkExpr` call can write 136 of the 186 fields, so no
   input struct can describe what these touch. Redesign first: an explicit expression
   checking context (scopes, flow state, type hint, current function) passed in,
   instead of ambient fields.
3. Scope, move, borrow and place tracking (move-state, borrows, moves, places,
   call-exclusivity; about 1850 lines). They change `VarInfo` records in place, reached
   through `scopes`, `closureFrames` and `borrowWindows`, and `recover` saves and
   restores `scopes`, `unsafeDepth`, `unsafeUsedStack`, `loopDepth`, `loopFrames`,
   `reachable`, `closureFrames`, `borrowWindows` by hand. A split would put the records
   in one file, their mutators in four, and the rollback list in a fifth. The overlap
   report also shows these four are one cluster, not four (`borrowModeOf`,
   `dropTypeInPath`, `shareMovedExpr`, `shareStringArg`, `isMovedPlaceArg` each belong
   to two of them). Redesign first: one flow-state struct with its own
   snapshot / restore, and move / borrow state in id-indexed tables (which ts2milo
   requires anyway). The state-free part (place-algebra) can go earlier.
4. `resolve` and monomorphization (670 lines, 55; writes 11 fields including `structs`,
   `enums`, `functions`, `monomorphizedFns`, and re-enters `checkFunction`). Needs the
   instantiation queue separated from checking before it can be a module.
5. `registerImpl` (26 exports, writes 10 declaration tables) and `processDerives`
   (13, writes 6). They are phases of `checkProgram` whose order matters; move them when
   `checkProgram` is cut into named phases with a declared table set per phase.
6. `programView` / `programPassHost` / `analysisFacts` (98 lines, 37 members, ratio
   37.8). This is the seam itself. It stays in checker.ts and shrinks as type-facts
   replaces its closures.
7. `error`, `warn`, `lookup`, `recover` and the scope stack. Every extracted piece calls
   back into them (referring members: `error` 126, `show` 81, `lookup` 52), and `error` has hidden
   behavior (span fallback from `currentFnDecl`; it drops a message that mentions the
   unknown type once an error exists). They are the host.
8. name-hints (13 fields read, two of them reassigned), unsafe-extern-notes (14 fields
   read), view-binds (13). Read-mostly but wide. Most of those fields are the tables
   type-facts would carry; measure again after it.
9. Portability claims. 67 of the 186 fields are Map / Set / WeakMap keyed by an AST
   node. A cluster whose interface is one of them (`nonExhaustiveMatches` in
   control-flow, `strandedCFnReads` in ffi-c-abi) can move in TypeScript now, but must
   not be called portable until that collection is an id-indexed table.
