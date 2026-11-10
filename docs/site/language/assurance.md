<!-- doc-meta
system: site-assurance
purpose: the public page on how Milo is checked: written semantics, reference interpreter, MLIR backend, contracts and proofs, the Lean proof, tracing to object code, runtime-error proofs; built vs planned stated plainly
key-files: docs/semantics/milo.md, src/interp.ts, src/verify.ts, src/object-trace.ts, proofs/README.md, docs/verification-roadmap.md, docs/plans/parallelism.md
update-when: a layer below ships, a number changes, or a planned item moves to built
last-verified: 2026-11-09
-->

# How Milo is checked

Most languages are checked by their test suite. Milo is checked in layers, and each layer catches
what the others miss. This page lists what exists today and, separately, what is planned.

## Built

### A written semantics

The core of the language, moves, borrows and drops, is written as precise rules in
[Milo Semantics](https://github.com/milo-language/milo/blob/main/docs/semantics/milo.md): about
twenty step rules for how a program runs, seven typing rules for what the checker accepts, and
the safety theorem connecting them. A rule reads like this:

```
                 F(x) = v    v is owned
[E-MOVE]       ──────────────────────────────────     reading an owned value moves it out
                 ⟨x, F, H⟩ ⇓ ⟨v, F[x ↦ moved], H⟩
```

The key fact the design buys fits in one paragraph: a reference can only sit in a parameter
slot, and that slot dies with its frame before the frame it points into. Stack order alone rules
out dangling references, with no lifetimes.

### A reference interpreter

`milo interp` runs a program straight from those rules, one function per rule, with no MLIR and
no LLVM. It's slow and small on purpose. Every program is run both ways, and any difference in
output, exit code or leaked memory is a bug in the compiler, the checker or the rules.

On its first run it found three compiler bugs the existing test suite had recorded as correct:

- a `match` with `_` first treated `_` as the default arm wherever it was written;
- a `for` range with an unsigned `u8` bound sign-extended it, so `0..200` ran zero times;
- a closure returned as a plain function value leaked its environment.

It runs in your browser too: try it in the [playground](/playground).

### MLIR as the only backend

The compiler lowers to its own MLIR dialect and emits the whole program from MLIR: every
function, global, type, drop and the process entry. Milo-specific passes run before LLVM sees
the code, with facts LLVM can't infer, such as which memory is a Vec header and which is its
elements. The dialect is documented in the [dialect reference](/mlir-dialect).

### Memory safety and no data races, by construction

Ownership and second-class references make use-after-free, double free and dangling references
impossible to write in safe code. Values move between tasks, references can't cross a task
boundary, and a task can't read a global another one writes, so there are no data races to
find. See [memory safety vs Rust](/language/vs-rust).

### Contracts, proven or checked

`requires`, `ensures`, loop and struct `invariant`, and `decreases` are part of the language.
`milo prove` hands each clause to z3, which proves it for every input, not just the ones you
tested, or returns the input that breaks it:

```milo
fn clamp(x: i64, lo: i64, hi: i64): i64
    requires lo <= hi
    ensures result >= lo && result <= hi
{
    if x < lo { return lo }
    if x >= hi { return x }    // bug: should return hi
    return x
}
```

```
$ milo prove clamp.milo
  ✗ [postcondition] clamp: failed — counterexample: x = 0, lo = -1, hi = -1, result = 0
```

A clause that is not proven is still enforced. Every build, release included, asserts
`requires` and `ensures` at the call, and a failure stops the run. Debug builds check loop
invariants too. `--no-contract-checks` removes the checks, and is safe exactly when the
clauses are proven. Struct invariants are proved by `milo prove` but have no run-time check.

### A Lean proof of what "proven" means

The word "proven" is a claim about the contract rules, so the rules are modelled in Lean 4 and
the claim is checked by Lean, in
[proofs/](https://github.com/milo-language/milo/blob/main/proofs/README.md). Three theorems
carry it:

- `sound`: a program whose obligations all hold never fails a contract clause, on any run.
- `level_irrelevant`: such a program has exactly the same runs with the checks on or off, so
  dropping them changes nothing.
- `checked_call`: in any program, proven or not, the default build only returns from a call
  whose `requires` and `ensures` both held.

The build fails on a `sorry` or a new axiom, and CI runs it on every push. The proof covers the
rules for integers, loops and calls. It does not cover the compiler's code, z3's answers, or
memory safety, whose theorem is written down but not yet proved.

### Requirements traceability

`@req(ID)` ties functions, contract clauses and tests to a `requirements.json`, and
`milo trace` prints the matrix: each requirement's implementation, the `milo prove` verdict of
each clause that formalizes it (a `requires` is judged at every call site), and its tests.
`milo trace` runs the `@req` tests (`--no-run` skips them). `--strict`, or a `--safety` profile whose
`traceability` field is `strict`, turns an untraced function, a requirement that is not verified
(DO-333: a requirement at or below the profile's `minTraceDepth` (root = 1; DO-178C A/B 2, others 1) is verified by a proven clause or a passing test; a shallower one needs a test. `requirements.json` follows `docs/schema/requirements.schema.json`: `derived`, `source`, `kind` and `verification` claims such as `{"method": "analysis"}`), a failing
test and an unproved clause into errors; a dev `build --safety` only warns, and `--baseline` lets an
existing codebase adopt a profile. A `verification` claim the tool cannot check (inspection, review, demonstration, or a test outside the unit env, such as `test@load`) is satisfied by an evidence record, committed beside `requirements.json` (`docs/schema/evidence.schema.json`); it goes stale when the requirement text or the code of the fns tagged `@req`/`@derived` changes (their callees are not hashed). `milo evidence add` is an attestation the tool cannot check; `milo evidence run -- <cmd>` captures a command's exit code and output, not whether the command measures the right thing. `--coverage` reports line coverage of the implementing code by the tests, and `--strict` fails on an uncovered line; branch and MC/DC coverage are not built. See [contracts & proofs](/language/safety#requirements).

`milo trace --refinement` also checks the requirements themselves, with no function bodies: for each `ensures` clause of a parent requirement, Z3 asks whether the fn's `requires` plus the `ensures` clauses of its descendants on the same fn imply it (a counterexample when not), and whether each fn's `requires` and `ensures` can be satisfied at all. It reaches only requirements with a formal clause: a parent clause with no child clause on the same fn is reported NOT COMPARABLE, never as a pass. Under `--strict`, NOT REFINED and unsatisfiable contracts fail.

### Requirements traced to object code

`milo trace <entry> --object <binary>` adds the last link: under each requirement, the address
ranges its functions became in the binary, read from the DWARF line table, including the
copies inlined into their callers. `milo trace-object <binary> --strict` goes the other
way and fails on any instruction that maps to no source line and no language rule (bounds
check, overflow trap, contract check, panic, drop). The
[PID controller demo](https://github.com/milo-language/milo/blob/main/examples/assured/pid/README.md)
runs both. This shows that every byte has a reason to exist. It does not show the bytes are the
right ones: that is translation validation, which is planned.

### Runtime-error proofs, with no annotations

`milo prove --rte` generates its own proof obligations for every overflow, index and division,
so it proves that a function can't trap, without any contracts written. Across `std` and the
embedded examples it proves about a third of the sites today, which is why it is opt-in; the
[verification roadmap](https://github.com/milo-language/milo/blob/main/docs/verification-roadmap.md)
has the census. Where it can't, it points at the assumption the code relies
on but never states, which is the contract worth writing. See [contracts & proofs](/language/safety).

### A spec lock for agent-written code

`milo spec --diff <ref>` compares every requirement, contract clause and invariant with a git ref,
and Z3 decides each changed clause. A strengthening passes. A weakening, a removal or a change to a
requirement's text fails `milo trace --strict --spec-base <ref>` until a person accepts it in
`spec-signoff.json`, and the diff prints the counterexample the weakening now allows. See the
[worked example](https://github.com/milo-language/milo/blob/main/examples/assured/intro/README.md#6-lock-the-spec).

### Clean-room tests

`milo spec --packet <dir>` writes the requirements and a stub of each source file: signatures and
contracts, no bodies, no private code, no comments. A test author given only that can't mirror the
implementation. On `std/json`, which already had full proofs and 48 passing tests, an AI agent working
from the packet wrote tests that found five real bugs and a requirement that misdescribed the code.
Keeping the author out of the source is up to you; the tool doesn't enforce it. See the
[worked example](https://github.com/milo-language/milo/blob/main/examples/assured/intro/README.md#7-test-it-independently).

## Planned

These are designed, and written up in the repository, but not built:

- **Whole-program invariants:** module-level `invariant` declarations over many values
  (`forall a in accounts: a.balance >= 0`), and temporal ones (`always`, `eventually`) for
  concurrent code, checked by exploring task schedules in the interpreter.
- **Safe parallelism with no deadlocks:** parallel scopes checked by the same rule that keeps
  `&mut` arguments apart, locks with levels so lock order can't form a cycle, and lock
  invariants proved by induction over critical sections.
- **Check Z3's proof output:** the prover asks Z3 for a proof, and a tiny independent
  checker verifies it, so trust rests on that checker rather than on the solver.
- **The memory-safety theorem in Lean:** the safety theorem of the written semantics, proved
  in the same Lean project as the contract rules.
- **Coverage and validation at the object level:** MC/DC measured on the object code, and
  translation validation that the binary computes what the MLIR says. No Milo tool is a
  qualified tool under DO-330.

The plans live in
[docs/verification-roadmap.md](https://github.com/milo-language/milo/blob/main/docs/verification-roadmap.md)
and [docs/plans/parallelism.md](https://github.com/milo-language/milo/blob/main/docs/plans/parallelism.md).

## Prior art

None of these ideas start here. Design by contract comes from Eiffel; temporal invariants from
TLA+; runtime-error proofs from SPARK and Astrée; reference interpreters from the WebAssembly
spec and Rust's Miri; executable semantics from the K framework. The framing of invariants as
rules an AI agent can't break comes from Bend's `LAWS.bend`. What's new is putting them together
in one systems language whose ownership model makes each of them simpler.
