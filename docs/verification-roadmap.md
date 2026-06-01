# Verification Roadmap: From Sealed Safety to Provable Properties

Status: exploratory. Parked for later — captured here so we don't re-derive it.

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

   fn push(v: &var Vec<T>, x: T)
       ensures v.len() == old(v.len()) + 1
   ```
2. **Dynamic-first.** Lower predicates to debug-mode `assert` traps. Ships value immediately with no solver. Mirrors the existing overflow-safety pattern (compile-time where possible, debug traps otherwise).
3. **Static discharge.** Checker emits verification conditions → Z3. Pass = compile-time proof. Fail = diagnostic with the solver's counterexample (Elm-style, via `diagnostics.ts`). SMT integration options below.
4. **Payoff pass.** When an index is proven in-bounds, codegen skips the bounds check. Verification becomes a perf feature, not just a safety feature.
5. **Stdlib first.** Annotate `Vec` indexing, integer ranges, slice ops. User types opt in — same rollout as the `@invalidates_refs` plan.

### Why SMT and not a homegrown checker

Refinement discharge is undecidable in general; SMT solvers (Z3) are the proven pragmatic answer (Dafny, F\*, Flux all do this). Building a bespoke theory solver is a research project with worse coverage. Reuse the solver.

## Open Questions

- **Sequencing:** A fully before B? (Assumed yes.)
- **B tier:** lock Tier 2? Or ship Tier 1 contracts standalone first as a product in their own right?
- **SMT integration:** shell out to the `z3` binary, libz3 via FFI (Milo has FFI now), or vendored? Build-time dependency story for users?
- **Refinement scope:** just bounds/ranges/non-null, or also user-defined struct invariants (`struct Account { balance: i64 } invariant balance >= 0`)?
- **Dynamic fallback location:** debug builds only, or a `--verify` opt-in? How does `--deny-unsafe` (aircraft-grade) interact — does it imply `--verify`?
- **`old()` / ghost state:** support `ensures` referencing pre-state? Adds real complexity to the VC generator.
- **Termination:** do refinements over recursive predicates need a termination checker? (Likely punt — keep predicates non-recursive initially.)

## Non-Goals

- Dependent types / hand-written proof terms (Tier 3). Out of scope by design.
- Full functional-correctness specs. Milo proves *safety and simple contracts*, not arbitrary program logic.
- Proving the compiler itself correct.
