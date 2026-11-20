<!-- doc-meta
system: verification
purpose: the machine-checked statement of what a proven contract means, what a build does with an unproven one, and why an accepted program never reads a moved place
key-files: proofs/MiniMilo/Contracts.lean, proofs/MiniMilo/Example.lean, proofs/MiniMilo/Moves.lean, proofs/MiniMilo/MovesExample.lean, proofs/MiniMilo/Borrows.lean, proofs/MiniMilo/BorrowsExample.lean, proofs/MiniMilo/Audit.lean
update-when: a contract rule changes (R-CONTRACT-*), a check level changes, a move-flow or borrow-flow rule or mutant changes, or a theorem is added or weakened
last-verified: 2026-11-19 (lake build green on Lean 4.35.0, no Mathlib)
-->

# Mini-Milo contract soundness, checked by Lean

`milo prove` says "proven". This directory states what that word means and has Lean check
the argument. It is a model of the contract rules, not a proof about the compiler's code.

```
cd proofs && lake build     # a few seconds cold; needs only elan, no Mathlib
```

The build fails on a `sorry`, on a new axiom, and on any theorem whose axiom list changes
(`MiniMilo/Audit.lean`). `tests/proofs.test.ts` checks the same files without Lean
installed, and CI runs the real build in the `proofs` job.

## What is proven

Mini-Milo is the part of Milo that carries contracts: `i64` variables, checked arithmetic,
`if`, `while` with an `invariant`, and calls to functions with `requires` and `ensures`.
A program is *verified* when every function's verification condition holds, which is what
`milo prove` asks z3 one obligation at a time.

| Theorem | Statement | Why it matters |
|---|---|---|
| `sound` | A verified program never fails a contract clause, at any check level. A call that returns satisfies its `ensures`. | "proven" means the clause holds on every run, not on the runs somebody tested. |
| `level_irrelevant` | A verified program has exactly the same runs at every check level. | `--no-contract-checks` cannot change what a proven program does. Dropping the checks is safe when, and only when, the proofs are there. |
| `checked_call` | In ANY program, proven or not, a build that checks boundaries only returns from a call whose `requires` and `ensures` both held. | The default build. An unproven clause is still enforced: the run aborts instead of continuing with a broken contract. |
| `proven_fn` | `sound` restated per function: with `requires` true on entry, the body never fails a clause and its result meets `ensures`. | The form a caller relies on. |
| `frame` | A statement changes only the variables it assigns. | Justifies the loop rule: facts about untouched variables survive the loop. |

`MiniMilo/Example.lean` keeps these from being empty claims. It proves one program verified
(`countTo`, a loop that needs the frame), exhibits a run of it, and shows both sides of an
unproven false `ensures`: the checked build aborts (`lies_fails_when_checked`) and the
unchecked build returns the wrong value (`lies_returns_when_unchecked`). The second is the
case `--no-contract-checks` opens, and the reason the default keeps the checks.

## How the model lines up with the compiler

| Lean | Rule in `docs/semantics/milo.md` | Compiler |
|---|---|---|
| `Level.boundary` | R-CONTRACT-ENTRY, R-CONTRACT-EXIT | `ContractChecks` `"boundary"` and `"all"` in `src/emit-mlir.ts` (default at every `-O`) |
| `Level.loops` | R-CONTRACT-LOOP | `"all"`: `-O0`, `--debug`, `--contract-checks` |
| `Level` `⟨false, false⟩` | none checked | `"none"`: `--no-contract-checks`, `--fast` |
| `Outcome.fail` | R-CONTRACT-FAIL | abort through `__milo_contract_fail`, exit 134 |
| `Outcome.trap` | overflow and division traps | `__milo_overflow_fail` and friends |
| `wp`, `Fn.Verified` | the obligations `milo prove` generates | `src/verify.ts` |
| `mods` (loop frame) | loop havoc of assigned variables | `src/verify.ts` |
| `Example.lies` | | `mlir/test/programs/contractsDefault.milo` |

## What the model leaves out

Said plainly, because a soundness theorem is only as wide as its model.

- **The link to the real verifier is by test, not by proof.** Lean checks that the rules
  are sound. That `src/verify.ts` implements those rules is checked by
  `tests/verify-contracts.test.ts` and `scripts/prove-soundness-fuzz.ts`, and z3's
  answers are trusted.
- **Traps are allowed.** `sound` rules out a contract failure. It does not rule out an
  overflow or a division by zero, which end the run in `trap`. Proving those absent is
  `milo prove --rte` (`docs/verification-roadmap.md`), and it is not modelled here.
- **Values only.** State is a map from names to integers. No heap, structs, slices,
  `&mut` parameters, `old()`, struct invariants or generics. The memory-safety theorem
  (`docs/semantics/milo.md` section 4) is a separate, larger proof and is still unproved.
- **Clauses are predicates.** A clause cannot itself trap or fail to terminate.
- **Partial correctness.** A run that never ends has no outcome, so the theorems say
  nothing about it. `decreases` is not modelled.
- **Loop invariants are checked before each test of the condition**, which is where the
  compiler puts the check.

## Move soundness

`MiniMilo/Moves.lean` models the move analysis in `src/move-flow.ts` (the graph is built in `src/place-cfg.ts`). A function body is
the control-flow graph of place events that move-flow builds. Branch conditions are left
out, so the theorem covers every path. The analysis is stated as the constraints its result
meets (a liveness solution, the string decision, the acceptance rules), so any solution is
sound, including move-flow's fixpoint.

| Theorem | Statement | Why it matters |
|---|---|---|
| `sound` | On every run of an accepted body, with move-flow's string decisions, no node reads a moved place (E-STUCK) or moves a borrowed one (T-NO-MOVE-OUT). | The property the interpreter checks on the corpus, for every program. |
| `strings_never_rejected` | A body whose only moves are of strings is accepted. | Strings are values: their moves become shares, never errors. |
| `noLend_stuck` | Without the lend rule (a call reads nothing), the analysis accepts `f(s, s)` with `f(a: &string, b: string)`, and the run gets stuck. | The bug 5dbc074a fixed. `sound` fails for that analysis, so the rule is needed for the proof, not just for one fixture. |
| `lend_shares`, `lend_never_stuck` | With the rule, the second argument shares and the run is never stuck. | |

### Rule trace

Each rule of move-flow is a mutant in `scripts/move-mutants.ts` (the gate that a test notices
when the rule breaks). Each row gives the mutant's counterpart in the model.
`tests/proofs.test.ts` fails when a mutant has no row.

| Mutant | Model |
|---|---|
| `lend-off` | `Ev.call` reads its lent places (`Ev.reads`); `noLend_stuck` |
| `string-always-move` | `decide`: move only when `liveOut` is false |
| `capture-always-move` | `decide`, on the `Ev.str` event at a `move` closure's creation |
| `ref-param-owned` | `borrowed`: `decide` shares, `Accepted.takeOwned` rejects a take |
| `view-let-owned` | `borrowed`, as above |
| `pattern-view-owned` | `borrowed`, as above |
| `closure-param-owned` | `borrowed`, as above |
| `assign-no-revive` | `Ev.assigns`: `update` clears the place, `Live.flows` stops at it |
| `forget-soft` | `Ev.take`: `forget(x)` is a take of `x` |
| `heap-deref-soft` | `Ev.take` of the payload place (the model's places are whole variables) |
| `no-loop-carry` | `Live.flows` over a back edge, like any edge ("out of a loop" is only the wording) |
| `never-call-falls-through` | graph construction: a node with no successor ends the run |
| `continue-no-back-edge` | graph construction: the edge from `continue` to the loop head |
| `subject-moves` | graph construction: where the take of a match subject sits |
| `closure-reads-nothing` | graph construction: using a by-reference closure is a `call` that reads its captures |
| `move-closure-borrows` | graph construction: a `move` closure's creation takes its captures |
| `overlap-exact` | not modelled: places are whole variables, no field paths |
| `call-once-reusable` | not modelled: closures that may run only once |

### What the move model leaves out

- **Graph construction.** The model takes the graph as given. `sound` holds for any graph
  that has every edge and every event the program can take, so a builder bug that drops an
  edge or an event is outside it. Six of the mutant rows above sit there, and the mutation
  gate is what checks them.
- **Field paths.** A place is a variable. move-flow tracks `v.name` and `v.res.id` and treats
  overlapping places as one.
- **Closures as values.** Captures appear only as events at creation and at calls.
- **The link to `src/move-flow.ts` is by test, as for contracts.** The interpreter, which is
  now strict about moves through references (T-NO-MOVE-OUT for strings too), checks `sound`'s
  conclusion on every fixture. `scripts/move-mutants.ts` checks that each rule in the table is
  one the tests notice when it breaks.

## Borrow soundness

`MiniMilo/Borrows.lean` models the borrow analysis in `src/borrow-flow.ts` (the graph is built in `src/place-cfg.ts`).
The dynamic side is E-BORROW (`docs/semantics/milo.md`): a state maps each place to a generation
(and an element-write count) and each holder to the place and generations it borrowed; a write
that can reallocate bumps the generation, and reading a holder whose record is stale is stuck.
A function body is the graph of events `loan h p kind`, `write p call|assign|elem|move`,
`read h`, `redef h` and `scopeEnd h`. Branch conditions are left out, so the theorem covers every
path. The analysis is stated as the constraints its result meets (a liveness solution `live` for
view and iteration holders, `pend` for pointer holders, a forward set `force` of loans in force,
and the acceptance rule), so any solution is sound, including borrow-flow's fixpoint.

| Theorem | Statement | Why it matters |
|---|---|---|
| `sound` | On every run of an accepted body, no node reads a stale view (E-BORROW). | The property the interpreter checks on the corpus, for every program: a view, an iterator or a pointer is never read after its buffer was reallocated. |
| `loansEndAtOnce_stuck` | With no holder liveness (a loan ends at once), the analysis accepts `let h = v.view(); v.push(1); use(h)` and the run gets stuck. | The NLL region is needed for the proof, not only for one fixture. |
| `elemIgnored_stuck` | If an element write is no conflict with an iteration loan, the analysis accepts `for x in v { v[i] = 1 }` and the run gets stuck. | An index write ends an iteration (the loop reads its iterator again), though it keeps a view. |
| `pointerByLiveness_stuck` | If a pointer loan follows Milo liveness instead of scope, the analysis accepts `let p = v.ptr(); v.push(1)` and the run gets stuck on the external read of `p` at scope end. | A pointer is read by code outside Milo (a worker, C) after its last Milo use. The scope-end read is an explicit `scopeEnd` event, so this is a modelling choice; it is the reason the implementation ends a pointer loan at the block, not at the last use. |
| `loansEndAtOnce_rejected_by_real`, `elemIgnored_rejected_by_real`, `pointerByLiveness_rejected_by_real` | The real analysis rejects each of those bodies. | The weakened analyses differ from the real one in exactly that rule. |
| `nll_accepted`, `nll_never_stuck` | `let h = v.view(); use(h); v.push(1)` is accepted, and its runs are never stuck. | The precision gained over a walk that holds a loan to the end of the holder's block, which rejects it. |

`BorrowsExample.lean` holds the example bodies. Each "needed" theorem comes with an accepted
body for the weakened analysis, the run that gets stuck, and the proof that the real analysis
rejects the body.

### Borrow rule trace

Each rule of the borrow flow is a mutant in `scripts/borrow-mutants.ts` (the gate that a test
notices when the rule breaks). Each row gives the mutant's counterpart in the model.
`tests/proofs.test.ts` fails when a mutant has no row.

| Mutant | Model |
|---|---|
| `loan-view-let-off` | graph construction: where the builder emits `Ev.loan` for a view or reference let |
| `loan-for-in-off` | graph construction: `Ev.loan` of kind `iteration` at a for-in head |
| `loan-if-let-ref-off` | graph construction: `Ev.loan` of a ref payload of an if-let subject |
| `loan-match-arm-ref-off` | graph construction: `Ev.loan` of a ref payload of a match subject |
| `loan-lines-off` | graph construction: `Ev.loan` of the receiver of `lines()` / `splitView()` |
| `loan-pointer-off` | graph construction: `Ev.loan` of kind `pointer` at a binding of `v.ptr()` |
| `loan-callback-off` | not modelled: callback loans (`v.each(cb)`), no callback kind |
| `loan-global-for-in-off` | not modelled: mutable globals are not places |
| `loan-index-for-in-off` | graph construction: the loan of `vs` for `for x in vs[i]` |
| `loan-global-slice-off` | not modelled: mutable globals are not places |
| `holder-dead-at-once` | `live` in `NoConflict.ok`: a view or iteration loan lasts while its holder is live; `loansEndAtOnce_stuck` |
| `holder-never-dead` | `live` in `NoConflict.ok`: precision, not soundness; `nll_accepted` |
| `pointer-by-liveness` | `pend` in `NoConflict.ok` (liveness that counts `Ev.scopeEnd`); `pointerByLiveness_stuck` |
| `holder-redef-keeps-loan` | `Ev.redef` and `Ev.defs`: `Forced.flows` stops at a redefinition (precision: a larger `force` is still sound) |
| `move-keeps-pointer-loans` | not modelled: a move of a pointer's source is a write that conflicts with every kind |
| `move-no-carry` | not modelled: loans that follow a moved local into a new binding |
| `field-move-no-carry` | not modelled: field paths |
| `move-conflicts-pointer` | not modelled: the model conservatively conflicts a move with a pointer loan |
| `pointer-carry-needs-only-pointers` | not modelled: loans that follow a moved local into a new binding |
| `callback-element-receiver-shallow` | not modelled: callback loans (`v.each(cb)`), no callback kind |
| `closure-global-write-off` | not modelled: mutable globals are not places |
| `unsafe-write-conflicts` | not modelled: `unsafe` blocks |
| `source-moved-off` | not modelled: a read of a pointer holder after its source moved is a use-after-free check on a raw pointer, and the model has no raw reads |
| `forget-kills-holders` | not modelled: `forget` (ownership of the buffer handed to a C owner) |
| `source-moved-in-unsafe` | not modelled: `unsafe` blocks |
| `source-moved-redef-keeps` | not modelled: raw pointer reads; the redefinition itself is `Ev.redef` |
| `source-moved-field-read` | not modelled: field paths and raw pointer reads |
| `return-pointer-off` | not modelled: the model has no function exit, so no pointer outlives its frame |
| `return-pointer-global` | not modelled: mutable globals are not places |
| `return-pointer-ref-param` | not modelled: reference parameters are not owners of storage |
| `return-node-off` | graph construction only: the event that marks the returned binding, same row as `return-pointer-off` |
| `self-call-not-write` | graph construction: a `&mut self` call is `Ev.write p call` |
| `collection-call-not-write` | graph construction: a mutating collection method is `Ev.write p call` |
| `assign-not-write` | graph construction: assigning a local is `Ev.write p assign` |
| `elem-assign-not-write` | graph construction: assigning through a field or index is a write of the base |
| `mut-arg-not-write` | graph construction: a `&mut` argument is `Ev.write p call` |
| `swap-not-write` | graph construction: `swap(a, b)` writes both places |
| `replace-not-write` | graph construction: `replace(a, v)` writes its first place |
| `closure-call-not-write` | graph construction: calling a closure writes what its body writes |
| `iteration-elem-write-harmless` | `conflicts .iteration .elem`; `elemIgnored_stuck` |
| `callback-elem-write-conflicts` | not modelled: callback loans |
| `elem-write-view-conflicts` | `conflicts .view .elem = false` (a view survives an element write; precision) |
| `elem-write-deep-view-harmless` | not modelled: deep views (a view into an element) |
| `overlap-exact` | not modelled: places are whole variables, no prefixes |
| `overlap-root` | not modelled: places are whole variables, no field siblings |
| `index-place-exact` | graph construction: `v[i] = x` is a write of the container `v`, kind `elem` |
| `park-ignored` | not modelled: parks and globals |
| `global-write-ignored` | not modelled: parks and globals |
| `effect-node-off` | not modelled: parks and globals |
| `callee-writes-off` | not modelled: parks and globals |
| `whole-move-unchecked` | `W.move` in `conflicts`: a move conflicts with every kind |
| `field-move-unchecked` | not modelled: field paths |

### What the borrow model leaves out

- **Graph construction.** The model takes the graph as given. `sound` holds for any graph that
  has every loan and write the program can perform, so a builder bug that drops one is outside
  it. Sixteen of the rows above sit there, and the mutation gate is what checks them.
- **Field paths and overlaps.** A place is a variable. borrow-flow tracks `v.name` and treats a
  prefix as overlapping; here two places overlap only when equal. Field-disjoint borrows are
  therefore not shown accepted.
- **Closures as values and callbacks.** No `callback` loan kind, no closure-write summaries
  beyond the write events at their calls.
- **Parks and globals.** A call that parks while a global's buffer is borrowed, and calls that
  write a global, are not modelled; nor are mutable globals as places.
- **Pointers.** A move of a pointer's source is a write that conflicts like any other, where
  borrow-flow lets the pointer follow the move. The model is stricter there, so `sound` is not
  weakened. `unsafe` writes are not modelled.
- **Deep views.** A view into an element is treated like any view, which survives an element write.
- **Iteration holder.** The loop is modelled as a holder read at each iteration; borrow-flow
  holds the loan for the whole body (`iterEnd`), which is the same set of nodes for a loop whose
  head reads the iterator.
- **The link to `src/borrow-flow.ts` is by test.** The interpreter checks `sound`'s conclusion on
  the corpus, and `scripts/borrow-mutants.ts` checks that each rule in the table is one the tests
  notice when it breaks.

## Extending it

Add the construct to `Stmt` and `Exec`, extend `wp` and `mods`, and re-prove `frame`,
`sound` and `level_irrelevant`: each is one induction over `Exec`, so a new constructor
shows up as a new unsolved case. Then add the theorem to `MiniMilo/Audit.lean`. No
Mathlib: `omega` and `simp` are enough, and a cold build stays in seconds.
