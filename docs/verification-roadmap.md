<!-- doc-meta
system: verification
purpose: the path from sealed safety to SMT-discharged contracts, and what each stage buys
key-files: src/checker.ts, std/smt.milo, src/verify.ts
update-when: a verification stage ships, a discharge strategy changes, or the solver story moves
last-verified: 2026-09-19
-->

# Verification Roadmap: From Sealed Safety to Provable Properties

Status: Part A done. Part B is partly SHIPPED — see "What shipped" below; the rest of this
doc is the original exploratory reasoning, kept because the tier argument still holds.

## What shipped

`milo prove` discharges contracts against `std/smt` (native, no external solver) or z3
(`--solver=z3`). The contract vocabulary is now:

| Clause | Meaning |
|---|---|
| `requires` | precondition, proved at every call site |
| `ensures` | postcondition, proved at every return |
| `invariant` on a loop | induction across `while` **and** `for in` |
| `invariant` on a struct | property of the type: assumed at use, owed at construction and at every `&mut` |
| `decreases` | termination measure, on a function or a loop |
| `old(e)` | the entry value of a scalar, inside `ensures` |

That set is, near enough, SPARK's — `Pre`, `Post`, `Loop_Invariant`, `Type_Invariant`,
`Loop_Variant`/`Subprogram_Variant`, `'Old`. Two of SPARK's are absent by choice: `Global`/
`Depends` (Milo's ownership rules make most of it unnecessary) and quantifiers.

**Where that lands us:** absence of runtime error on scalar and index arithmetic, plus
termination and simple data invariants — SPARK's "silver" level. NOT functional correctness.

**The one structural gap: quantifiers.** `forall`/`exists` over container contents, and the
sequence theory to go with them. Without it, sortedness is not merely hard to prove, it is
*unstateable*, and binary search cannot be specified at all. Deliberately not chased: trigger
selection is where Dafny/Verus users actually burn their time, and it contradicts this doc's
own "no annotation burden" principle. `std/smt` is Fourier-Motzkin over linear integers and
cannot represent quantifiers at all, so adding them would also make the in-box solver
permanently second-class. Revisit only with a concrete demand that nothing else answers.

**Floats (2026-07-25).** `f32`/`f64` were declared as SMT `Real` all along, but `exprToSmt`
had no `FloatLit` case, so the first constant in a float contract turned the whole VC into
`(UNSUPPORTED FloatLit)` — 28 of the tree's unknowns, and the reason
`examples/embedded/flightController.milo` scored 0 proven / 64 unknown. It is 11 / 55 now
(the 55 are std postconditions outside the entry file, not solver limits), and the two
failures the fix surfaced were real: `pidNew` checked `outMin < outMax` and `pidUpdate` had
no way to know it, which is what `invariant outMin < outMax` on the struct now carries.

Translating floats meant `std/smt` finally saw a `Real`, and that exposed a **false proof**
that had been reachable the whole time through a plain `f64` parameter. Its two integer
tightenings — folding `L < 0` into `L + 1 <= 0`, and rounding a bound in by the coefficient
gcd — are exact over Z and nonsense over R. Applied to `requires x > 0.0 && x < 1.0` they
produced `x >= 1 && x <= 0`, the system went infeasible, and infeasible is how this solver
spells *proven*: every postcondition of such a function verified, z3 refuting them all the
while. `SmtProblem` now carries a `varIsInt` flag per variable and the tightenings are
skipped for any row mentioning a real. Regression: `tests/prove/floatNoFalseProof.milo`.

Capability did not have to be given up for it. Fourier-Motzkin is a *relaxation* only when
integers are involved; on an all-real system it decides satisfiability exactly, so those
now come back `failed` with a real counterexample instead of `unknown`. Rational
coefficients reach the i64 rows by per-atom scaling (multiplying an inequality by a
positive constant preserves its solution set).

**`assert E` as a proof cut (2026-08-16).** The practical substitute for quantifiers, and
it needed no new syntax at all: `assert` was already a builtin. Each one is now proven where
it is written, under the path conditions that reach it, and then ASSUMED by everything
downstream — so a user can hand the solver the single intermediate fact that reconnects a
goal to its premises.

Assuming it is sound for a reason specific to `assert` and unavailable to a bare `assume`:
codegen emits an unconditional abort on a false assert, in every build mode, so no execution
reaches the next statement with E false. There is deliberately no `assume` form; an
unchecked one is a false proof with a keyword.

A cut whose own VC is not discharged still feeds the assumption — ordinary
assume-guarantee, the same deal a callee's `ensures` gets — so each cut carries an identity
and every VC that leaned on it names it. Without that, `assert(a >= 100)` refuted with a
counterexample and the postcondition it made trivial reported a clean tick.

Measured on the shape it is for: `sumTo`'s `ensures result >= 0` is *refuted* without a cut,
because the walker havocs `s` at the loop and the postcondition becomes a claim about a free
variable. With the cut it is proven, and the report says which fact it rests on until a loop
invariant discharges the cut too (`tests/prove/proofCut.milo`: 7/7, unconditional).

**Where a cut does NOT help, and it is worth knowing before reaching for one.** `std/smt`
rejects any row containing a nonlinear product, so asserting a fact *about* such a term
leaves both the cut and its consumer unknown — `let a = w * h; assert(a >= 1)` lowers `a`
back to `(* w h)` in both. A cut buys something only where the connection was lost
(a loop havoc, a branch) and not where the *term* is untranslatable. Fixing that case means
abstracting a nonlinear subterm to a fresh constant, which is a different change.

**Next, in order of leverage per unit of syntax:**

1. **Range subtypes.** `MiloType` already carries `rangeMin`/`rangeMax` (`i32(0..50000)`).
   Propagating those into `intRangeAssumption` retires the `pidStep` baseline, whose whole
   problem is that only *parameters* carry range facts, so `setpoint - measured` escapes to
   ±2^32 in the unbounded-Int model. Mostly plumbing over an existing representation.
3. **`@pure`.** `modelCall` deliberately refuses to share a constant between two identical
   call sites, because a Milo function may read mutable global state. Purity unlocks that.
4. **`old` at loop entry** (SPARK's `'Loop_Entry`).

Original exploratory notes follow.

Context: comparison against proof-oriented languages (Bend2 et al.) raised the question of how far Milo should go on formal verification. Milo today is a *sealed safety contract* — its checker mechanically proves a fixed property set (memory, null, race, overflow, coercion safety) via sound static analysis. It is not a theorem prover: you cannot state and prove your own program properties.

This doc lays out (A) finishing the sealed contract, then (B) optionally letting users assert custom properties — and argues for the SMT-refinement tier, not dependent types.

Guiding principle (unchanged from `safety-roadmap.md`): static analysis first, no annotation burden, false positives unacceptable, dynamic checks only as fallback. Verification must not turn Milo into a proof-obligation grind.

## Part A: Close the Sealed Contract First

This is committed work already specced in `safety-roadmap.md` Phases 2–3. Do it before any new verification theory. It reuses the move checker's existing dataflow framework — no solver, no new surface.

Order of operations:

1. **Phase 2a — ref-while-frozen.** A collection is frozen while a `&`/`&var` into it is live; mutation is a compile error. Same taint-tracking as the move checker.
2. **Phase 2b — use-after-invalidate.** `.push()` (may realloc), `.clear()`, reassignment taint live refs. Stdlib methods annotated `@invalidates_refs`.
3. **Phase 3a — call-site exclusivity.** A variable cannot appear as both a `&var` argument and the source of a `&` argument at one call site. Pure argument-origin check — no interprocedural dataflow.

**Status (done):** 2a (ref-while-frozen) already held — reassigning a frozen var errors. 2b (use-after-invalidate) is largely N/A today: the only into-collection borrows are string slices (Vec has no slice API), and reassign-while-sliced is already caught. 3a (call-site exclusivity) was the one real hole — `f(&mut v, &v[0])` compiled and silently corrupted after a reallocating `push`; now rejected (`checker.ts checkCallSiteExclusivity`, fixture `tests/errors/callSiteExclusivity.milo`). The sealed contract is sound for the patterns expressible today.

Payoff: the *existing* contract becomes genuinely sound. Highest ROI verification work available. No reason to leap to custom proofs before this lands.

## Part B: User-Asserted Properties

Goal: let users state properties (bounds, ranges, invariants) and have the compiler prove them — without writing manual proof terms.

### The tier decision

| Tier | Mechanism | Proves | Cost | Prior art |
|------|-----------|--------|------|-----------|
| 1 | Contracts, runtime-checked | `requires`/`ensures`/`assert`, debug traps | Low | Eiffel (Design by Contract) |
| **2** | **Refinement types + SMT (Z3)** | bounds, ranges, non-null, simple invariants — auto-discharged | Med | Dafny, Liquid Haskell, F\*, Flux (Rust) |
| 3 | Dependent types + proof terms | arbitrary theorems, hand-written proofs | Very high | Bend2, Lean, Agda, Coq |

**Recommendation: Tier 2.**

- Tier 3 (dependent types) is a different language identity — manual proofs, enormous surface, directly contradicts "no annotation burden." That's the Bend2 lane; not Milo's.
- Tier 2 is the systems-language sweet spot: user writes a *predicate*, the SMT solver proves it, zero proof terms. And it pays for itself — proven-safe indexing lets codegen delete runtime bounds checks, tying verification straight into the "fast like C" goal.
- Tier 1 is the cheap on-ramp and should be how Tier 2 ships first (dynamic before static).

### Tier 2 concrete path

1. **Syntax.** Refinement predicates on types and functions. Predicates are pure boolean Milo expressions.
   ```
   fn get(v: &Vec<T>, i: usize{i < v.len()}) -> &T
   fn divide(a: i32, b: i32{b != 0}) -> i32

   fn push(v: &mut Vec<T>, x: T)
       ensures v.len() == old(v.len()) + 1
   ```
2. **Dynamic-first.** Lower predicates to debug-mode `assert` traps. Ships value immediately with no solver. Deliberately NOT the overflow-safety pattern: overflow traps in every build mode, because an overflow is the machine doing something other than the arithmetic says. A contract is a claim the author wrote down, so it defaults to debug and `--contract-checks` forces it on at any optimization level.
3. **Static discharge.** Checker emits verification conditions → Z3. Pass = compile-time proof. Fail = diagnostic with the solver's counterexample (Elm-style, via `diagnostics.ts`). SMT integration options below.
4. **Payoff pass.** When an index is proven in-bounds, codegen skips the bounds check. Verification becomes a perf feature, not just a safety feature.
5. **Stdlib first.** Annotate `Vec` indexing, integer ranges, slice ops. User types opt in — same rollout as the `@invalidates_refs` plan.

### Why SMT and not a homegrown checker

Refinement discharge is undecidable in general; SMT solvers (Z3) are the proven pragmatic answer (Dafny, F\*, Flux all do this). Building a bespoke theory solver is a research project with worse coverage. Reuse the solver.

## Open Questions

- **Sequencing:** A fully before B? (Assumed yes.)
- **B tier:** lock Tier 2? Or ship Tier 1 contracts standalone first as a product in their own right?
- **SMT integration:** shell out to the `z3` binary, libz3 via FFI (Milo has FFI now), or vendored? Build-time dependency story for users?
- ~~**Refinement scope:** ... also user-defined struct invariants?~~ **Resolved: yes.** Written
  after the closing brace over bare field names. Two-sided — assumed at every use, owed at
  every literal and every `&mut` function — because the assume half alone is an unchecked hole.
- **Dynamic fallback location:** debug builds only, or a `--verify` opt-in? How does `--deny-unsafe` (aircraft-grade) interact — does it imply `--verify`?
- ~~**`old()` / ghost state:** support `ensures` referencing pre-state?~~ **Resolved: yes,
  scalars only.** The VC-generator cost was real but bounded: postconditions had to move from
  being lowered against entry symbols to being lowered per exit path, and call sites needed a
  frame assumption relating the post-call havoc symbols back to the pre-call ones. That last
  piece is what makes it useful to a CALLER rather than only provable at the definition.
  Builtin `Vec`/`string` methods get the same frame from a contract table written in Milo
  (`BUILTIN_CONTRACTS_SRC`, `src/verify.ts`), and a havoc that NO contract, guard or invariant
  describes can no longer be reported as `failed`: the verdict is `unknown`, naming the free
  value. See roadmap.md §Contracts & Proving for the table and the rule.
- ~~**Termination:** ... need a termination checker?~~ **Resolved: yes, and it was not
  optional.** A self-recursive call is modelled by assuming the function's own `ensures`;
  without a measure that is induction over a possibly-non-terminating recursion, which proves
  anything. `decreases` supplies it, and a proof that leaned on recursion without a discharged
  measure is now reported as conditional rather than clean.

## Non-Goals

- Dependent types / hand-written proof terms (Tier 3). Out of scope by design, and re-examined with evidence on 2026-09-01: see [proofs-vs-contracts.md](proofs-vs-contracts.md) for what was measured, the one-sentence rule for users, and the four triggers that would reopen it.
- Full functional-correctness specs. Milo proves *safety and simple contracts*, not arbitrary program logic.
- Proving the compiler itself correct.
