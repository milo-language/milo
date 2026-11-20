<!-- doc-meta
system: verification
purpose: the machine-checked statement of what a proven contract means, what a build does with an unproven one, and why an accepted program never reads a moved place
key-files: proofs/MiniMilo/Contracts.lean, proofs/MiniMilo/Example.lean, proofs/MiniMilo/Moves.lean, proofs/MiniMilo/MovesExample.lean, proofs/MiniMilo/Audit.lean
update-when: a contract rule changes (R-CONTRACT-*), a check level changes, a move-flow rule or mutant changes, or a theorem is added or weakened
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

## Extending it

Add the construct to `Stmt` and `Exec`, extend `wp` and `mods`, and re-prove `frame`,
`sound` and `level_irrelevant`: each is one induction over `Exec`, so a new constructor
shows up as a new unsolved case. Then add the theorem to `MiniMilo/Audit.lean`. No
Mathlib: `omega` and `simp` are enough, and a cold build stays in seconds.
