<!-- doc-meta
system: consolidation-sweep
purpose: plan for the 2026-11 consolidation pass: every definition site of six core concepts, the drift found between them, the single source proposed for each, and a brief per change
key-files: src/mutability-scan.ts, src/builtin-members.ts, src/mlir-glue.ts, src/layout.ts, src/owned-temp.ts, src/types.ts, src/cli-help.ts, scripts/gen-ownership-cells.ts, tests/exhaustiveSwitchLint.test.ts
update-when: a brief below lands, or a blocked file (src/checker.ts, src/emit-mlir.ts) is free again
last-verified: 2026-11-09 (planning only, no source changed)
-->

# Consolidation pass, 2026-11

Planning document. No source was edited. Every claim is tagged **(run)** when a command was
executed and its output seen, or **(read)** when it comes from reading code only.
Runs used `bun src/main.ts check|interp --live|run <file>` with
`MILO_OPT` set to the built `mlir/build/milo-opt`.

Blocked files: `src/checker.ts` and `src/emit-mlir.ts` (under active edit elsewhere).
A brief that needs either is marked **BLOCKED**. Unblocked briefs come first in every list.

## 0. Bug candidates (stage disagreements), most serious first

### BUG-1. A user `Drop` on an enum never runs in the compiled binary (run)

FIXED 2026-11-12: the enum arm of `dropAt` calls the user drop, unguarded (moves end a
binding statically, so no moved-out enum reaches it). A match on an owned Drop enum now
borrows it (Rust's E0509); moving a payload out of an rvalue Drop enum is an error.
Fixtures `tests/fixtures/enumUserDrop.milo`, `tests/errors/dropEnumMoveOutRvalue.milo`.

```milo
enum Tok { A(string), B }
impl Drop for Tok { fn drop(self: &mut Self): void { print("drop tok") } }
fn main() {
    let _t = Tok.A("x".repeat(3))
    let _u = Tok.B
    print("end")
}
```

- `interp`: prints `end`, `drop tok`, `drop tok`. `run`: prints `end` only. (run)
- Same result with an all-scalar payload (`A(i64)`). (run)
- Cause (read): `src/mlir-glue.ts:519-533`, the enum arm of `dropAt`, drops payload fields and
  never calls `userDrop`; the struct arm at `:534-543` does. `userDrop` (`:556`) handles structs
  only. `src/layout.ts:124-135` `droppableEnums` ignores `dropImpls`, while `structNeedsDrop`
  (`:309`) includes it.
- No test covers it (read): the only enum with `impl Drop` under `tests/` is the reject case
  `tests/errors/cloneDeriveEnumDrop.milo`. `docs/spec.md:1119` treats Drop on an enum as a
  supported feature.
- Fix: brief D1 (unblocked).

### BUG-2. An enum with all-Copy payloads and a `Drop` impl is treated as Copy by the checker (run)

FIXED 2026-11-12: `isAllCopyEnum` returns false for a Drop type before its cache, as
`isAllCopyStruct` does. Covered by `second()` in `tests/fixtures/enumUserDrop.milo`.

```milo
enum Tok { A(i64), B }
impl Drop for Tok { fn drop(self: &mut Self): void { print("drop tok") } }
fn main() {
    let t = Tok.A(1)
    let _u = t
    let _x = t
}
```

- `check`: ok. `interp`: exit 4, `stuck at E-COPY: t: read of an owned enum Tok.A that the checker
  did not mark as a move`. `run`: `mlir: main is not covered: let copies a borrowed value`. (run)
- Same with two by-value calls instead of two lets. (run)
- A struct field of that enum type (`struct W { t: Tok }`) fails `run` with
  `mlir: W$Clone$clone is not covered: field copies a borrowed value` while `interp` runs. (run)
- Cause (read): `src/checker.ts:8168` `isAllCopyEnum` has no `dropImpls.has(name)` check;
  `isAllCopyStruct` (`:8185`) has one. `docs/language-reference.md:2827` says Drop types are
  never Copy. `whyNotCopy` (`:2832`) has no Drop reason for enums either.
- Fix: brief T3 (**BLOCKED**, checker.ts). Today both backends refuse, so nothing is miscompiled.

### BUG-3. Enum payload drop order differs between interpreter and binary (run)

```milo
struct D { id: i64 }
impl Drop for D { fn drop(self: &mut Self): void { print(self.id) } }
enum E { P(D, D), Q }
fn main() {
    let _e = E.P(D { id: 1 }, D { id: 2 })
}
```

- `interp`: `2`, `1`. `run`: `1`, `2`. (run)
- Struct fields, arrays, Vec and HashMap agree between the two. (run)
- Cause (read): `src/interp.ts:215-218` drops payloads last-first; `src/mlir-glue.ts:529` uses
  `forEach` (first to last). Struct fields are last-first on both sides
  (`scripts/ownership-rules.ts:49` states last-first for struct fields; no rule states payloads).
- Fix: brief D2 (unblocked). Decision made here: payloads drop last-first, same as struct fields.

### BUG-4. `string.reverse()` is treated as a write to the receiver (run)

```milo
fn main() {
    let s = "abc"
    let v = s.slice(0, 2)
    let r = s.reverse()
    print(v)
    print(r)
}
```

- `check` rejects: `cannot call 'reverse' on 's' while 'v' borrows it`. `string.reverse` returns a
  new string (`src/builtin-members.ts` sig `(): string`). (run)
- Second symptom: `var s = "abc"; let r = s.reverse()` gets no `var-never-reassigned`. (run)
- Cause (read): `MUTATING_COLLECTION_METHODS` (`src/builtin-members.ts:234`) is a list of names,
  applied to vec, hashmap and string receivers alike at `src/checker.ts:13835`.
- Fix: briefs W1 (unblocked, table) then W4 (**BLOCKED**, checker call site).

### BUG-5. A user function named `swap`, `replace` or `take` hides `var-never-reassigned` (run)

```milo
fn swap(x: i64, y: i64): i64 { return x + y }
fn swop(x: i64, y: i64): i64 { return x + y }
fn main() {
    var a = 1
    var b = 2
    var c = 3
    var d = 4
    print(swap(a, b))
    print(swop(c, d))
}
```

- `check` reports `c` and `d` only; `a` and `b` are missed. Same for `fn take(x: i64)`. (run)
- Cause (read): `src/mutability-scan.ts` `afterCall` matches `n.func === "swap" || "replace" ||
  "take"` by name and marks every argument written. `take` is not a free builtin at all (it is the
  Option method; `o.take()` is already counted through the checker's written set, run).
- Fix: brief W2 (unblocked).

### Not bugs, recorded

- `print((if c() { r } else { mkv(2) })[0].id)` on `Vec<D>`: `interp` runs, `run` refuses with
  `mlir: main is not covered: view fork arm that owns its value`. A refusal, not a miscompile. (run)
- Six other mixed-fork shapes agree between `interp` and the binary. (run)
- Sixteen forms of writing through a `let` (index, field, compound assign, `for &mut`, `&mut`
  argument, closure capture, `swap`, Vec methods) are all rejected by `check`; the two raw-pointer
  forms inside `unsafe` are accepted and agree on output. (run)
- The same forms on a `var` produce no false `var-never-reassigned`. (run)

## 1. What counts as a write

### Definition sites

| Site | Decides | Verified |
|---|---|---|
| `src/checker.ts:10094` `errorIfFrozen` (callers `:6263 :10121 :10196 :13837 :14592`) | fills `writtenExprs`; the checker's main "this expression is written" fact | read |
| `src/checker.ts:1868`, `:9406`, `:13083`, `src/checker-mutability-host.ts:32` | the same 4-way test repeated: `written` or `autoBorrowed.mutable` or `explicitMutArgs` or `matchSubjectMut` | read |
| `src/checker.ts:9992` `isRootMutable`, `:10220` `unwritableMutTarget`, `:6138` `refuseImmutableReceiver` | whether a place may be written | read |
| `src/checker.ts:13873` to `:14383` | 21 per-method `isRootMutable` checks, each with its own message (push, truncate, clear, pop, reverse, swap, insert, remove, sort, sortBy, sortByKey, extend, reserve, hashmap insert, string push, setByte, pushStr, pushInt, string truncate/clear) | read |
| `src/builtin-members.ts:234` `MUTATING_COLLECTION_METHODS` | name-level list of receiver-writing methods; used at `checker.ts:13836` and `checker-program-passes.ts:139` | read |
| `src/mutability-scan.ts` (modes 0 to 3) | lint-side writes: checker `mutated` ids, assign root, `for` over `&mut` or by-value aggregate, `&mut`, `addrOf`/`ptr`, array `as *T`, free calls named swap/replace/take, closure captures | read |
| `src/checker-mutability.ts` | emits `var-never-reassigned`, `unwritten-mut-param` from the scan | read |
| `src/fixes.ts:76` | `milo fix` only applies the diagnostic's span; it has no definition of its own | read |
| `src/interp.ts:333` `setPlace`, `:1322` `assign`, `:992` `memReplace`, `:999` `memSwap` | dynamic writes; no mutability test (trusts the checker) | read |
| `src/emit-mlir.ts:2183` `assign` (from `:1935`) | store paths; no mutability test | read |

### Drift

BUG-4 and BUG-5 above. No case found where a write is accepted by `check` on a `let` (run, 16 forms).

### Single source

1. `BUILTIN_MEMBERS` rows get a `mutates: true` flag. `MUTATING_COLLECTION_METHODS` is deleted;
   callers ask `memberMutates(receiverTag, name)`.
2. One helper `isWrittenExpr(e)` in the checker replaces the four copies of the 4-way test, and
   the host imports the same helper.
3. The 21 per-method checks collapse to one check before the method chain, driven by the flag,
   with one message template (`cannot call '<m>' on immutable <receiver>`). See section 7, chain 1.
4. `mutability-scan.ts` stops matching names; the host passes "this call is the builtin swap or
   replace" as a fact.

### Briefs

**W1 (unblocked). Add `mutates` to the builtin member table.**
- Files: `src/builtin-members.ts`, `tests/builtinMembers.test.ts`.
- Change: add optional `mutates?: true` to the member row type; set it on every row whose receiver
  and name appear in `MUTATING_COLLECTION_METHODS` AND whose signature writes the receiver
  (`string.reverse` does not). Export `memberMutates(receiver: string, name: string): boolean`.
  Keep `MUTATING_COLLECTION_METHODS` for now, with a comment that W4 deletes it.
- Invariant: for vec and hashmap receivers, `memberMutates` equals membership in the old list.
- Gate: new test in `tests/builtinMembers.test.ts`: every name in the old list is `mutates` on at
  least one receiver; the set of (receiver, name) pairs where the old list and the flag disagree
  is exactly `[["string","reverse"]]`. Run `bun test tests/builtinMembers.test.ts`.
- Number: drift test 0 -> 1; known disagreements pinned at 1.
- Commit: `add per-receiver mutates flag to builtin member table`

**W2 (unblocked). Stop matching free calls by name in the mutability scan.**
- Files: `src/mutability-scan.ts`, `src/checker-mutability-host.ts`, new
  `tests/errors` or warning fixture next to the existing `var-never-reassigned` tests.
- Change: delete the `"take"` arm (no free builtin has that name). For `swap`/`replace`, mark the
  arguments in the host: in `factsFor`, a `Call` whose `func` is `swap` or `replace` and that the
  checker resolved to the builtin (no user function of that name in `functions`; reuse the
  shadow test the interpreter uses at `src/interp.ts:1165`) adds its args to `mutated`. Remove the
  name test from `afterCall`. `mutability-scan.ts` is a ts2milo portable pass: keep it inside the
  subset and run the portable gate.
- Invariant: builtin `swap(a, b)` and `replace(a, v)` still count as writes of their place args.
- Gate: the BUG-5 program must report four warnings (a, b, c, d); a program using builtin
  `swap(a, b)` on two `var` must report none. `bun test tests/mutabilityWarnings.test.ts` (add both programs there), then `bun test tests/ts2milo.test.ts` in the background for the portable subset

- Number: name-matched write rules 3 -> 0.
- Commit: `mutability scan: resolve swap/replace instead of matching names`

**W3 (BLOCKED, checker.ts). One `isWrittenExpr` helper.**
- Files: `src/checker.ts:1868 :9406 :13083`, `src/checker-mutability-host.ts:32`.
- Change: one method holding the 4-way test; four call sites use it.
- Gate: `grep -c "explicitMutArgs.has" src/checker.ts src/checker-mutability-host.ts` drops to 1;
  `bun test tests/explicitMut.test.ts`.
- Number: copies 4 -> 1.
- Commit: `checker: one iswrittenexpr helper for the written test`

**W4 (BLOCKED, checker.ts). Use `memberMutates` and delete the name list.**
- Files: `src/checker.ts:13835-13838`, `src/checker-program-passes.ts:139`, `src/builtin-members.ts`.
- Change: both callers call `memberMutates(receiverTag, method)`; delete
  `MUTATING_COLLECTION_METHODS`.
- Gate: BUG-4 program checks clean and prints `ab` then `cba` under `interp` and `run`;
  `var s = "abc"; let r = s.reverse()` reports `var-never-reassigned`.
- Number: definition sites 2 -> 1; W1's pinned disagreement 1 -> 0.
- Commit: `checker: receiver-aware mutating method test, fixes string.reverse`

**W5 (BLOCKED, checker.ts).** Collapse the 21 per-method mutability checks. See section 7, chain 1.

## 2. What drops a value, and when

### Definition sites

| Site | Decides | Verified |
|---|---|---|
| `src/checker.ts:8581` `tryMove`, `:8591` `tryMoveLeaf`, `:8820` `tryMoveOutOfHeap`, `:8468` `consumeForwardedPayload`, `:8551` `consumeMixedResourceFork` | which expressions move (fills `movedExprs` `:973`, `viewLets` `:974`, `movedByPattern` `:998`) | read |
| `src/checker.ts:8560` `forkHasOwnedTail`, `:8570` `tailIsOwnedValue` (default arm returns `true`) | whether an `if`/`match` arm tail is an owned value | read |
| `src/owned-temp.ts:261` `isOwnedTempExpr`, `:168` `blockValueOwnsResult`, `:343` `defaultValueOwnsResult`, `:141` `indexAccessClones`, `NOT_OWNED_TEMP` | codegen's "this expression yields an owned temporary" | read |
| `src/owned-temp.ts:88/:106` `closureParamEscapes`/`paramEscapesBody` | codegen's own "closure parameter escapes" walk, next to the checker's `checkEscapingClosures` | read |
| `src/emit-mlir.ts:1870` `consume`, `:2183` `assign`, 26 `milo.move` and 4 `milo.drop` emission sites | where moves and explicit drops are emitted | read |
| `mlir/Drops.cpp` (`milo-scope-drops`, `milo-elaborate-drops`), `mlir/Milo.cpp:303` `needsDrop` | scope-exit drops in the binary | read |
| `src/mlir-glue.ts:449` `dropAt`, `:556` `userDrop`, `:318` `cloneParts` | per-type drop and clone glue | read |
| `src/interp.ts:204` `dropValue`, `:243` `userDrop`, `:1017` `forkOwns`, `:1024` `blockValue`, `:1322` `assign` | the oracle's drops, by runtime shape | read |
| `scripts/gen-ownership-cells.ts`, `scripts/ownership-cells-baseline.json` (1450 covered cells) | the differential gate: op x representation x type class | read |
| `scripts/ownership-rules.ts` | the stated rules (MILO-O ids, rendered into `docs/spec.md`) | read |

### Drift

- BUG-1 and BUG-3.
- The cell generator has no type class for "enum with a user Drop" and no drop-order cell for
  enum payloads, which is why both bugs passed 1450 covered cells. (read)
- `docs/plans/ownership-table.md` is named by `scripts/gen-ownership-cells.ts` and
  `docs/scripts.md:79` but is not tracked (`docs/plans/` is under an ignore rule). (run: `git ls-files docs/plans`)
- `scripts/ownership-rules.ts` header still names `src/codegen.ts`, which no longer exists;
  `src/interp.ts` header still names `src/lower.ts` and HIR. (read)
- The interpreter's fork-consume test is "the value's own type has Drop" (`src/interp.ts:1046`);
  the checker and codegen use the transitive test. No disagreeing program found (run, 7 shapes).

### Single source

The interpreter stays an independent oracle on purpose, so it is compared, not merged. The single
source for "who is right" is the cell table: every new type class or representation is a cell, and
the baseline is the visible number. Inside the compiler, "owned value expression" should be one
checker fact that codegen reads (section 7, chain 2).

### Briefs

**D1 (unblocked). Run a user Drop on enums in the binary.**
- Files: `src/mlir-glue.ts:519-533` and `:556`, `src/layout.ts:124-135`,
  `scripts/gen-ownership-cells.ts`.
- Change: in `dropAt`'s enum arm, call the user Drop first when `dropImpls.has(name)`, then drop
  payloads (same order as the struct arm: user Drop, then parts). Extend `userDrop` to accept an
  enum. In `droppableEnums`, seed the fixpoint with enums that have a Drop impl. Add type class
  `enumdrop` to the generator: `enum ED { A(D), B }` with `impl Drop for ED` printing a marker,
  plus a scalar-payload variant.
- Invariant: an enum without a Drop impl emits the same glue as before (diff the `emit-mlir`
  output of one existing enum cell before and after: identical).
- Gate: BUG-1 program prints `end`, `drop tok`, `drop tok` under both `interp` and `run`;
  `bun scripts/gen-ownership-cells.ts --filter enumdrop` reports wrong 0.
- Number: new cells wrong N -> 0; drift test 0 -> 1.
- Commit: `run user drop on enums in the binary, add enumdrop cells`

**D2 (unblocked). Enum payloads drop last-first.**
- Files: `src/mlir-glue.ts:529`, `scripts/gen-ownership-cells.ts` (new `drop-order` cell
  `enum-payloads`), `scripts/ownership-rules.ts` (state the rule next to the struct-field rule,
  then `bun scripts/gen-spec.ts`).
- Change: iterate payload fields in reverse.
- Invariant: single-payload enums are unchanged.
- Gate: BUG-3 program prints `2`, `1` under both; `bun scripts/gen-ownership-cells.ts --filter
  'drop-order-enum-payloads'` wrong 0; `bun test tests/spec.test.ts`.
- Number: cell wrong 1 -> 0.
- Commit: `drop enum payloads last-first, matching struct fields`

**D3 (unblocked). Restore or unlink the ownership table doc.**
- Files: `scripts/gen-ownership-cells.ts` header, `docs/scripts.md:79`.
- Change: if `docs/plans/ownership-table.md` exists on main, bring it into the branch; otherwise
  point both references at this file's section 2.
- Gate: `bun test tests/docLinks.test.ts tests/scriptsDoc.test.ts`; extend docLinks to check
  backticked `docs/...md` paths in `scripts/*.ts` headers so this cannot recur.
- Number: dangling doc references 2 -> 0.
- Commit: `fix dangling ownership-table doc references`

**D4 (unblocked). Stale header comments.** `scripts/ownership-rules.ts` (src/codegen.ts),
`src/interp.ts` (src/lower.ts, HIR), `src/types.ts` (src/lower.ts). Gate: `grep -n
"src/codegen.ts\|src/lower.ts" src scripts -r` returns 0 lines. Commit:
`drop comment references to deleted codegen.ts and lower.ts`

## 3. Which types are Copy, need Clone, need Drop

### Definition sites

| Site | Decides | Verified |
|---|---|---|
| `src/types.ts:180` `isCopy` | Copy, structurally (struct/enum through callbacks) | read |
| `src/checker.ts:8168` `isAllCopyEnum`, `:8185` `isAllCopyStruct`, `:15113` `isCopyType`, `:2832` `whyNotCopy` | the callbacks and the explanation text | read |
| `src/checker.ts:1646` `resourceKind`, `:1688` `dropTypesIn`, `:1801` `viewBindPure`, `:9840` `dropTypeInPath` | "owns a resource", "which Drop types are inside", per rule | read |
| `src/types.ts:208` `needsDrop` | `string`, `heap`, `vec`, `hashmap` only | read |
| `src/layout.ts:297` `needsDropCg`, `:309` `structNeedsDrop`, `:124` `droppableEnums` | needs drop glue, over layouts | read |
| `src/emit-mlir.ts:275` `ownsStructurally`, `:296` `runsUserDropT`, `:318` `ownsOf`, `:461` `aggregateType` | the same two questions again, over checker types | read |
| `src/owned-temp.ts:196` `typeRunsUserDrop` | "runs a user Drop", third copy | read |
| `mlir/Milo.cpp:303` `milo::needsDrop` | the same, over dialect types | read |
| `src/checker-derive.ts:135` `canAutoClone`, `:63` `enumCloneBlocker` | Clone derivability | read |
| `src/interp.ts:405` `copyable`, `:419` `share`, `:480` `deepClone`, `:204` `dropValue` | the oracle, by runtime shape | read |

`src/derive-*.ts` and `src/emit-forms.ts` contain no type-class predicate of their own (run: grep
for `isCopy|needsDrop|canAutoClone|dropImpls|noCopy` finds only checker-derive, mlir-glue, mlir-ctx).

### Drift

- BUG-2: `isAllCopyEnum` vs `isAllCopyStruct` on `dropImpls` (run).
- BUG-1 is the same asymmetry on the layout side: `droppableEnums` vs `structNeedsDrop` (read).
- `typeRunsUserDrop` (`owned-temp.ts:196`) answers `true` for `fn`; `runsUserDropT`
  (`emit-mlir.ts:296`) answers `false`. Two copies of one predicate in the same backend. No
  disagreeing program found yet. (read)
- "Needs drop" exists five times: `types.ts:208`, `layout.ts:297`, `emit-mlir.ts:275`,
  `mlir/Milo.cpp:303`, and `interp.ts:204` by shape. (read)

### Single source

New `src/type-facts.ts`: one memoized function `typeFacts(t, env)` returning
`{ copy, ownsHeap, runsUserDrop, hasRawPointer, whyNotCopy }`, where `env` gives struct fields,
enum variants, `dropImpls`, `noCopy`. Struct and enum go through the same code path, so an
asymmetry like BUG-1/BUG-2 cannot be written. The checker, `layout.ts`, `owned-temp.ts` and
`emit-mlir.ts` all call it. `mlir/Milo.cpp` and the interpreter stay separate and are compared by
a gate that enumerates type shapes.

### Briefs

**T1 (unblocked). Type-class differential gate (no behaviour change).**
- Files: new `tests/typeClassAgreement.test.ts`.
- Change: build a fixed list of about 40 type shapes (scalar, string, Vec of each, struct and enum
  with and without Drop, with and without `@noCopy`, fn, owning closure, interface, Heap of each,
  nested). For each, check a tiny program and compare: checker `isCopyType` vs interpreter
  `copyable` on a value of that type; `layout.needsDropCg` vs `ownsOf(...)` vs "the interpreter
  frees or runs something at scope exit" (live-block count before and after). Known disagreements
  go in a named list with a reason.
- Invariant: the test reads the type list from one table, and fails if the list has fewer than 30
  entries or the known-disagreement list names a shape that now agrees.
- Gate: `bun test tests/typeClassAgreement.test.ts` fails if the BUG-2 entry is removed from the
  known list before T3 lands.
- Number: drift test 0 -> 1; known disagreements expected 2 (BUG-1 shape until D1, BUG-2 shape).
- Commit: `add type class agreement test across checker, layout, interp`

**T2 (unblocked). `src/type-facts.ts` and move the backend onto it.**
- Files: new `src/type-facts.ts`; `src/layout.ts` (`needsDropCg`, `structNeedsDrop`,
  `droppableEnums`), `src/owned-temp.ts:196`.
- Change: implement `typeFacts`; `needsDropCg` and `typeRunsUserDrop` become one-line calls.
  For `fn`, keep each caller's current answer by passing the question explicitly
  (`runsUserDrop` false for a plain `fn`, true for an owning closure) and record in a comment
  which caller relied on which answer.
- Invariant: `bun scripts/gen-ownership-cells.ts --check --reuse` unchanged; T1 unchanged.
- Gate: T1 plus `bun test tests/ownedTempCoverage.test.ts`.
- Number: definition sites 5 -> 3 (types.ts, Milo.cpp, emit-mlir.ts remain).
- Commit: `one typefacts summary for layout and owned-temp`

**T3 (BLOCKED, checker.ts). Enum with Drop is not Copy.**
- Files: `src/checker.ts:8168` (add `if (this.dropImpls.has(name)) return false`), `:2832`
  (`whyNotCopy` enum case names the Drop impl).
- Gate: BUG-2 program is rejected by `check` with a use-after-move on `t`; T1's known list
  shrinks by one.
- Number: known disagreements 2 -> 1 (0 after D1).
- Commit: `checker: an enum with a drop impl is not copy`

**T4 (BLOCKED, checker.ts and emit-mlir.ts). Move the checker and emitter onto `typeFacts`.**
- Files: `src/checker.ts` (`isAllCopyEnum`, `isAllCopyStruct`, `resourceKind`, `dropTypesIn`,
  `dropTypeInPath`, `viewBindPure`), `src/emit-mlir.ts:275-318`.
- Gate: T1, `bun scripts/gen-ownership-cells.ts --check --reuse`.
- Number: definition sites 3 -> 2 (TypeScript side 1, Milo.cpp 1).
- Commit: `checker and emitter read type classes from typefacts`

## 4. Which builtins and intrinsics exist

A name drift test already exists (`tests/builtinNameDrift.test.ts`). A shared
`PUBLIC_BUILTIN_FNS` constant was tried and reverted: spreading it into `mlir-ctx.ts` costs two
points on the portability ratchet. The test records four intrinsics the interpreter does not implement:
`_callClosureVoid`, `_panicHookSet`, `_schedulerGet`, `_schedulerSet`. (read)

### Hand lists that remain

| Site | Holds | Verified |
|---|---|---|
| `src/checker.ts:3995-4048` | 37 registered names with signatures | read |
| `src/checker.ts`, 33 names tested as `.func === "x"` | forms typed by special case (isNull, swap, replace, forget, sizeOf, offsetOf, zeroed, old, embedFile, targetOs, targetArch, jsonStringify, adoptVec, rawSliceMut, Heap, Some, Ok, Err, ...) | run (grep census) |
| `src/builtin-names.ts:2` | 9 public names | read |
| `src/interp-natives.ts:379` and `nat(...)` entries from `:211` | interpreter dispatch | read |
| `src/mlir-ctx.ts:43` `BUILTINS` | codegen "is a builtin" | read |
| `src/emit-mlir.ts:657` `NATIVE_BUILTINS` (14), `src/emit-forms.ts` (15 special names) | lowering choice | read |
| `src/lsp.ts:1578` | completion list of 12; omits exit, assert, swap, replace, sizeOf, zeroed, forget, isNull | read |
| `src/checker-purity-host.ts:16` `PURE_BUILTINS` | 4-name allowlist: format, max, min, assert | read |
| `src/lang-info.ts` | exports builtin methods only; free builtins are absent from `milo lang --json` | read |

### Single table

`src/builtin-fns.ts`, one row per name:

```ts
export interface BuiltinFn {
  name: string;
  /** public: user-callable. internal: `_name`, std only. form: typed by a checker special case. */
  vis: "public" | "internal" | "form";
  /** Milo signature text when fixed, e.g. "(a: i64, b: i64): i64"; null when the checker types it by form. */
  sig: string | null;
  arity: [min: number, max: number];
  pure: boolean;
  /** builtinCall: handled in BUILTIN_FNS. native: a nat() entry. none: not implemented, reason required. */
  interp: "builtinCall" | "native" | { none: string };
  /** native: NATIVE_BUILTINS. form: emit-forms. atomic: ATOMIC_INTRINSICS. inline: emitted in place. */
  codegen: "native" | "form" | "atomic" | "inline";
  /** Offered by lsp completion and listed by `milo lang --json`. */
  complete: boolean;
  doc: string;
}
```

Who reads it:

| Consumer | Becomes | Blocked |
|---|---|---|
| `builtin-names.ts` `PUBLIC_BUILTIN_FNS` | `rows.filter(vis public)` (file deleted) | no |
| `interp-natives.ts` `BUILTIN_FNS` | `rows.filter(interp builtinCall)`; a load-time check that every `interp native` row has a `nat()` entry | no |
| `mlir-ctx.ts` `BUILTINS` | `rows.filter(vis != form)` | no |
| `checker-purity-host.ts` `PURE_BUILTINS` | `rows.filter(pure)` | no |
| `lsp.ts:1578` | `rows.filter(complete)` | no |
| `lang-info.ts` | new `builtinFunctions` field, rendered by `scripts/gen-lang-docs.ts` | no |
| `emit-mlir.ts:657` `NATIVE_BUILTINS` | `rows.filter(codegen native)` | BLOCKED |
| `checker.ts:3995-4048` | a loop over rows with `sig`, parsed once | BLOCKED |
| `checker.ts` 33 `.func ===` tests | unchanged; the table lists the names so the drift test can count them | BLOCKED |

### Briefs

**B1 (unblocked). Create the table and move the five unblocked consumers.**
- Files: new `src/builtin-fns.ts`; `src/builtin-names.ts` (delete), `src/interp-natives.ts:379`,
  `src/mlir-ctx.ts:43`, `src/checker-purity-host.ts:16`, `src/lsp.ts:1578`,
  `tests/builtinNameDrift.test.ts`.
- Change: fill rows from the current lists (the checker registration gives `sig` and arity).
  Derive the five sets. Extend the drift test: checker `builtinNames` equals table rows with
  `vis != form`; `NATIVE_BUILTINS` (read from emit-mlir.ts source text until B3) equals rows with
  `codegen native`; rows with `interp.none` equal the old `INTERP_MISSING_INTRINSICS`.
- Invariant: the derived `BUILTIN_FNS`, `BUILTINS`, `PURE_BUILTINS` are set-equal to today's
  (assert once in the test with the literal old lists, then delete the literals in the same
  commit). The lsp list grows; that is the intended change.
- Gate: `bun test tests/builtinNameDrift.test.ts tests/stdBuiltinNames.test.ts`.
- Number: hand lists 8 -> 3 (checker registration, checker forms, NATIVE_BUILTINS).
- Commit: `one builtin function table for interp, mlir-ctx, purity, lsp`

**B2 (unblocked). `milo lang --json` lists free builtins.**
- Files: `src/lang-info.ts`, `scripts/gen-lang-docs.ts`, `tests/langInfo.test.ts`.
- Gate: `bun test tests/langInfo.test.ts tests/langDocs.test.ts`.
- Number: public builtins documented from the table 0 -> 9 plus forms.
- Commit: `lang --json: list builtin functions from the table`

**B3 (BLOCKED, emit-mlir.ts and checker.ts).** Derive `NATIVE_BUILTINS` and the checker
registration loop from the table. Gate: the drift test with its source-text comparison removed.
Number: hand lists 3 -> 1. Commit: `checker and emitter register builtins from the table`

## 5. The CLI surface

Already consolidated: `src/cli-help.ts` is the table; the banner, the known-command set,
`milo lang --json` (`commands`, `cliOptions`) and `docs/site/cli.md` are rendered from it;
`tests/cliHelp.test.ts` compares the dispatch chain in `src/main.ts` against it. (read)
No shell completions exist (run: find). `src/skill.ts` writes its command examples by hand.

### Drift

The flag test sees only `src/main.ts` and only three spellings (`args[i] === "--x"`,
`startsWith("--x=")`, `rest.includes("--x")`): 39 of 98 flag literals in `src/`. (run)
Flags a user can type that `milo --help` and `docs/site/cli.md` do not mention (run: grep of the
help output):

| Flag | Read at |
|---|---|
| `--explore`, `--schedule`, `--max-schedules`, `--random`, `--seed`, `--host-fs`, `--allow-nondeterministic-output` (all `milo interp`) | `src/interp-run.ts:22-46`, `src/main.ts:2030` |
| `--bin`, `--dry-run`, `--force` (pkg verbs) | `src/pkgcli.ts:989`, `:754`, `:828` |
| `--internal`, `--out` (`milo api`) | `src/api-search.ts:448`, `:348` |
| `--no-run` (requirements) | `src/requirements.ts:901` |
| `--solver=z3` (accepted and ignored) | `src/verify.ts:3493`, `src/requirements.ts:900` |

`--schedule` is printed by the tool itself as the replay command (`src/interp-explore.ts:261`) and
described in `docs/site/features/concurrency.md:607`, yet `milo --help` does not list it.

### Briefs

**C1 (unblocked). Document the missing flags and widen the gate.**
- Files: `src/cli-help.ts`, `tests/cliHelp.test.ts`, then `bun scripts/gen-lang-docs.ts` for
  `docs/site/cli.md`.
- Change: add the 13 flags above under their commands (mark `--solver` as accepted for
  compatibility). In the test, scan every `src/*.ts` for `"--[a-z-]+=?"` string literals; each
  must be documented in the table or named in an `EXTERNAL_TOOL_FLAGS` list with the tool it is
  passed to (git, objdump, diff, llvm tools: about 20 names such as `--porcelain`, `--depth`,
  `--macho`, `--label`).
- Invariant: the scan count must be above 80, so a broken regex cannot report zero.
- Gate: `bun test tests/cliHelp.test.ts`; removing one new table row must fail it.
- Number: undocumented user flags 13 -> 0; literals the gate sees 39 -> 98.
- Commit: `document interp, pkg and api flags; gate scans all of src`

**C2 (unblocked). Check the commands named in the skill text.**
- Files: `tests/skillText.test.ts`.
- Change: every `milo <word>` in a shell fence of `src/skill.ts` must be in `knownCommandNames()`,
  and every `--flag` on such a line must be in the table.
- Gate: `bun test tests/skillText.test.ts`.
- Number: drift test 0 -> 1.
- Commit: `skill text: commands and flags must exist in the cli table`

## 6. The AST node kinds

### Definition sites

| Site | Role | Verified |
|---|---|---|
| `src/ast.ts` | 25 Expr kinds, 15 Stmt kinds, patterns, clauses, decls | run (script count) |
| `scripts/gen-ast-walk.ts` | generates `src/ast-nodes.ts`, `src/ast-walk-types.ts` and 12 walkers (`src/ast-walk*.ts`) from `ast.ts`; `--check` mode; referenced by `tests/ts2milo.test.ts` | read |
| Main dispatchers, all bound to `never`: `checker.ts:7016 :8484 :9563 :10540`, `interp.ts:677 :1272`, `interp-gen.ts:223 :591`, `emit-mlir.ts:1931`, `emit-forms.ts:295`, `lsp.ts:1912 :1952`, `mangle.ts:181 :278`, `safety.ts:560 :872 :911`, `visibility.ts:127 :213`, `wcet.ts:58` | a new kind is a compile error here | run (script) |
| `emit-mlir.ts:2865` | Expr switch, 20 of 25 kinds, `default: throw MlirUnsupported` (loud) | run |

### Where a new kind is swallowed

`tests/exhaustiveSwitchLint.test.ts` accepts ANY `default:` arm. Of 49 switches over Expr or Stmt
kinds (run: `scratchpad/switches.ts`), 20 are `never`-guarded, 1 throws, and 28 have a default
that answers for every kind not listed. A new kind gets that answer with no diagnostic.

Silent no-op defaults:

| Site | Kinds listed | Default |
|---|---|---|
| `src/checker-closure-env.ts:59` (default at `:90`) | 4 of 15 Stmt | `break` (children visited after) |
| `src/checker-escaping-closures-host.ts:66` (`:91`) | 7 of 25 Expr | `break` |
| `src/checker-program-passes.ts:366` (`:376`) | 5 of 15 Stmt | `break` |
| `src/interp.ts:276` (`:297`) | 4 of 25 Expr | `break` (comment: only place kinds reach it) |
| `src/interp-gen.ts:25` (generated twin) | 4 of 25 Expr | `break` |
| `src/verify.ts:1765` (`:1826`) | 6 of 25 Expr | `break` (generic descent after) |

Defaults that return an answer about a property (a new kind silently gets it):

| Site | Default | Risk |
|---|---|---|
| `src/checker.ts:8571` `tailIsOwnedValue` (`:8577`) | `return true` | new kind is assumed owned |
| `src/checker.ts:9077` `isConstGlobalInit` (`:9106`) | `return false` | safe direction |
| `src/checker.ts:8060` (`:8081`) | falls through: "control continues" | a new diverging statement would be missed |
| `src/checker.ts:3655`, `:6747`, `:8922`, `:11871` | `return out` / `null` / message | read each when touched |
| `src/owned-temp.ts:279` `isOwnedTempExpr` (`:328`) | `return false` | covered: `tests/ownedTempCoverage.test.ts` pins the unlisted kinds in `NOT_OWNED_TEMP` |
| `src/interp.ts:265` `isPlaceExpr` (`:270`) | `return false` | differs in shape from checker `isPlaceExpr` (`checker.ts:15123`, `rootNameOf`) |
| `src/const-fold.ts:30`, `:88` | `return null` | safe (not foldable) |
| `src/contract-tests.ts:652`, `src/verify.ts:667 :700 :3231` | stated "unsupported" value | safe |
| `src/checker-sql.ts:126`, `src/checker-thread-boundary-host.ts:128`, `src/emit-forms.ts:258`, `src/harden-rewrites.ts:400`, `src/interp.ts:1502`, `src/lsp.ts:103`, `src/safety.ts:537` | `null` / `[]` / `false` / `0` | review: `safety.ts:537` returns 0 for a count |

Not covered by the lint at all: `if (e.kind === "X")` chains (not counted here).

### Single source

`ast.ts` is already the source and the generator covers the walkers. The gap is the lint's
"any default passes" rule. The `NOT_OWNED_TEMP` pattern is the fix: a default arm must be backed
by a list of the kinds it answers for, checked against the union.

### Briefs

**A1 (unblocked). Tighten the switch lint.**
- Files: `tests/exhaustiveSwitchLint.test.ts`.
- Change: classify each default as loud (throws), stated (`never`), or catch-all. A catch-all
  default must be on a line carrying `// default-for: <reason>` or the switch must be in a new
  `CATCH_ALL` table (file:function, reason, direction: safe or unsafe). Start with the 28 sites
  above; `unsafe` entries are `checker.ts:8571`, `checker.ts:8060`, `safety.ts:537`.
- Invariant: the test fails when a catch-all switch is added without an entry, and when an entry
  names a switch that no longer exists. Key entries by function name, not line number.
- Gate: `bun test tests/exhaustiveSwitchLint.test.ts`; adding `default: return false` to a copy of
  a `never` switch must fail it.
- Number: unreviewed catch-all defaults 28 -> 0 (all listed); unsafe-direction entries 3.
- Commit: `switch lint: a catch-all default needs a recorded reason`

**A2 (unblocked). Turn the six no-op defaults outside blocked files into listed kinds.**
- Files: `src/checker-closure-env.ts:59`, `src/checker-escaping-closures-host.ts:66`,
  `src/checker-program-passes.ts:366`, `src/interp.ts:276` (then `bun scripts/gen-interp-co.ts`),
  `src/verify.ts:1765`, `src/safety.ts:537`.
- Change: list the remaining kinds explicitly in one `case` group that breaks, and bind the
  default to `never`.
- Gate: TypeScript typecheck (`bunx tsc --noEmit`; no typecheck script was found in package.json, not run here) plus the A1 test.
- Number: catch-all defaults 28 -> 21 (six hand-written plus the generated twin).
- Commit: `list node kinds explicitly in six partial switches`

**A3 (BLOCKED, checker.ts).** Same for `checker.ts:8571` and `:8060`. Number: unsafe entries 3 -> 0.
Commit: `checker: exhaustive tailisownedvalue and divergence switches`

**A4 (unblocked). Gate audit for the generator.** Confirm `bun scripts/gen-ast-walk.ts --check`
fails after adding a throwaway Expr kind to a scratch copy of `ast.ts` (the script reads ROOT; run
it against a copied tree in the scratchpad). Number: gate proven to fail 0 -> 1. No commit unless
it does not fail.

## 7. Checker rules that grew as lists of special cases: the three worst

Census of `src/checker.ts` (run: grep counts): 106 `.method === "..."`, 100 `name === "..."`,
35 `.func === "..."`, 34 lines carrying an immutable-place message.

### Chain 1. Builtin method calls (`checker.ts` about `:13400` to `:14600`)

- Property approximated: per builtin method, "writes its receiver", "retains its argument",
  "grows the collection", plus its signature.
- Shape: 83 `method ===` tests in five 200-line windows; 21 hand-written `isRootMutable` checks;
  a separate name list (`MUTATING_COLLECTION_METHODS`) for the borrow rule. BUG-4 comes from the
  two disagreeing.
- Compute once: `BUILTIN_MEMBERS` row flags (`mutates`, existing `retainsArg`, `grows`). One
  check ahead of the per-method typing: `if (memberMutates(tag, m) && !isRootMutable(recv))
  error(...)`.
- Briefs: W1 (unblocked), W4, then **W5 (BLOCKED)**: delete the 21 checks. Gate: every test under
  `tests/errors` whose expected text matches `cannot .* immutable` still passes after the
  expected strings are regenerated once and reviewed; count of `isRootMutable(` call sites in the
  method section 21 -> 1. Commit: `checker: one immutable-receiver check from the member table`

### Chain 2. "Is this expression a place, a view, or an owned value"

- Sites: `checker.ts:15123` `isPlaceExpr`, `:8560` `forkHasOwnedTail`, `:8570`
  `tailIsOwnedValue`, `:8551` `consumeMixedResourceFork`; `src/owned-temp.ts:261`
  `isOwnedTempExpr` with `NOT_OWNED_TEMP`, `:168` `blockValueOwnsResult`, `:141`
  `indexAccessClones`; `src/interp.ts:265` `isPlaceExpr`, `:1017` `forkOwns`.
- Property approximated: the value category of an expression (place, borrowed view, owned
  temporary), decided per node kind in three components.
- Compute once: the checker records `valueCategory` per expression in `CheckResult` while typing
  it (it already knows: it decides moves there). `owned-temp.ts` reads the fact instead of
  re-deriving it; the interpreter keeps its dynamic answer and a gate compares the two on the
  ownership cells.
- Briefs: **V1 (unblocked)**: a census script `scripts/value-category-census.ts` that runs the
  checker over `tests/` programs and, per Expr kind, counts where `isOwnedTempExpr` and the
  checker's move decision disagree (owned temp that the checker also marked moved, or neither).
  Number: disagreement count, unknown today, becomes the baseline. Commit:
  `add value category census between checker and owned-temp`.
  **V2 (BLOCKED, checker.ts and emit-mlir.ts)**: add the fact, switch `owned-temp.ts` to it,
  delete `NOT_OWNED_TEMP`. Gate: V1 census at 0, `bun scripts/gen-ownership-cells.ts --check
  --reuse`. Number: definition sites 3 -> 1 (plus the oracle).

### Chain 3. Type-class walks

- Sites: `checker.ts:1646` `resourceKind`, `:1688` `dropTypesIn`, `:1801` `viewBindPure`, `:8168`
  `isAllCopyEnum`, `:8185` `isAllCopyStruct`, `:2832` `whyNotCopy`, `:9840` `dropTypeInPath`
  (struct only), `:15113` `isCopyType`.
- Property approximated: a per-type summary (Copy, owns heap, runs a user Drop, holds a raw
  pointer), re-walked per rule with a different subset of cases each time. BUG-2 is one walk
  missing a case its sibling has.
- Compute once: `typeFacts` (section 3). Briefs T1, T2 unblocked; T3, T4 blocked.

## 8. Order of work

Unblocked, in this order (each is independent of the blocked files):

1. D1 (BUG-1), D2 (BUG-3): real behaviour bugs in the binary.
2. W2 (BUG-5), W1 (table half of BUG-4).
3. C1, C2: CLI flags and gate.
4. A1, A2, A4: switch lint.
5. T1, T2: type-class gate and shared summary.
6. B1, B2: builtin table.
7. V1, D3, D4.

Blocked until `src/checker.ts` / `src/emit-mlir.ts` are free: T3 (BUG-2), W4 (BUG-4), W3, W5, T4,
B3, A3, V2.

D1, D2, T2 and V1 need judgment about glue and ownership: review those diffs line by line.
W1, W2, C1, C2, A1, A2, B1, B2, D3, D4 are bounded and gated.

## 9. Probe material

The probe programs and scripts used for the runs above are not part of the repo; the repro
programs are reproduced inline in section 0.
