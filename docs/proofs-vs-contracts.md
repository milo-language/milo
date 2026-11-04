<!-- doc-meta
system: verification
purpose: why Milo proves properties with SMT-discharged contracts instead of Curry-Howard proof terms, and what was measured before deciding
key-files: src/verify.ts, docs/verification-roadmap.md, docs/ownership-model.md, docs/milo-idioms.md
update-when: one of the revisit triggers below fires, or the propositional encoding stops working
last-verified: 2026-09-01 (every command in this file was run; the counterexample and the two compile results are real output)
-->

# Proofs or contracts: why Milo has no proof terms

Milo can already write propositions as types. This is not a proposal; it compiles today:

```milo
enum False { }

struct And<P, Q> {
    left: P,
    right: Q,
}

enum Or<P, Q> {
    Left(P),
    Right(Q),
}

type Not<P> = move (P) => False

// ex falso: from False, anything. The proof is that there is nothing to match.
fn absurd<P>(f: False): P {
    match f {
    }
}
```

De Morgan, modus ponens and double-negation introduction all type-check the same way, and
generic type aliases (2026-09-01) mean `Not<P>` is spelled exactly as the literature spells
it. So the question is not "can the type system express propositions". It can. The question
is whether Milo should make that a *proof system* the language stands behind.

**It should not.** The reasoning below is what was measured, not what was assumed.

## The thing a proof system needs, Milo already has, pointed the other way

A proof only means something if every proof term terminates. Today:

```milo
enum False { }

fn fakeProof(): False {
    return fakeProof()
}
```

That type-checks. Non-termination inhabits every type, so under a Curry-Howard reading
every proposition is provable and the encoding proves nothing.

Milo can already refuse it, on the contract side:

```
$ milo prove fakeProof.milo
verification: 1 conditions
  proven: 0  failed: 1  unknown: 0  errors: 0

  ✗ [termination] fakeProof: failed — counterexample: n = -1
```

with a `decreases n` clause. **The termination checking a proof system would need is built,
opt-in, and attached to contracts.** Making it mandatory on a new category of values is the
expensive part, and it buys the weaker of the two mechanisms.

## What full adoption costs, item by item

| Requirement | Milo today | If skipped |
|---|---|---|
| Totality on proof terms | `decreases` exists, opt-in, contract-side | every proposition is provable via recursion |
| Positivity for inductive types | **absent**: `enum Bad { C(move (Bad) => False) }` compiles clean | Curry's paradox; the system is inconsistent by construction |
| Proof erasure | absent; a proof struct is a value with layout and drop glue | proofs cost memory and destructor work at runtime |
| Dependent types | absent; monomorphization-based codegen has nowhere to put them | propositions cannot mention values, which is the whole point |

The positivity row is the sharpest: a negative occurrence behind a storable closure is
accepted right now, so a proof system built on today's types would be unsound on day one,
and closing it restricts where owning closures may appear inside inductive types.

## Move semantics is a designed-in contradiction, not a papercut

A proof is a value, and values in Milo are moved. A conjunction whose halves own heap is
consumed by its first projection (`use of moved variable`), while a conjunction of scalars
copies, and a proof expressed as a closure can be called twice. Proofs would therefore be
affine-with-exceptions, which is not a rule anyone can teach.

There is a deeper version. A witness about a mutable container cannot be revoked when the
container changes, because tying a witness to its subject needs a stored borrow, and stored
borrows are what the [ownership model](ownership-model.md) forbids on purpose. The SMT
pipeline has no such problem: it havocs what a `&mut` could have changed.

## Two models, or one? One, and here is the sentence

**Use types to make wrong values unconstructible. Use `requires`/`ensures` for facts about
values that do exist, and `milo prove` checks them.**

The same specification, "division requires a nonzero denominator", written three ways and
run:

- **Contract** — `requires b != 0`, one line, and a guarded call site proves with no further
  annotation: `1 conditions, proven: 1`.
- **Type-level witness** — a `NonZero` newtype behind a smart constructor: nine extra lines,
  `Option` handling at every construction site, and it is checked by construction discipline
  rather than by anything the compiler verifies.
- **Runtime check** — `assert(b != 0)`, one line, and it doubles as a proof cut, so it feeds
  the prover too.

One measured result worth stating because it is easy to assume otherwise: **neither the
contract nor the witness removes the runtime division guard.** Both emit it. Proving a
contract does not currently inform codegen, and type-level knowledge never reaches it
either. The witness buys no runtime anything; the contract buys a machine-checked claim.

## What the encoding IS good for, and already delivers

None of these need a language change, and all of them are the honest content of
"propositions as types" in a systems language. See [milo-idioms](milo-idioms.md):

- **Uninhabited types marking dead branches.** `Result<T, Never>` for infallible code needs
  no `Err` arm at all: exhaustiveness skips a variant whose payload cannot exist (shipped
  2026-09-01, the one slice this review recommended). Writing the arm and discharging it with
  `match e { }` stays legal and stays a checked argument rather than an `abort()`.
- **Witness / token types.** A single-field struct obtainable only from the function that
  establishes the invariant.
- **Phantom brands.** `struct Id<Tag> { raw: i64 }` rejects a cross-pool mixup.
- **Typestate.** Move checking already is a substructural type system: a consumed `File`
  cannot be used again. This is Curry-Howard content Milo shipped on day one.

## Revisit triggers

Named in advance so this is a decision rather than a dogma:

1. **Bounded `forall i in a..b` ships and array properties are still unstateable.** Sortedness
   cannot be specified today ([backlog](backlog.md) 12), and indexed types state it naturally.
   The bounded quantifier is the counter-bet; if it lands and still fails, indexed types
   deserve a real hearing.
2. **Users independently build witness towers for value properties.** Brands are fine, but
   chains of `Positive`, `Sorted`, `InBounds` in the wild would mean the contract vocabulary
   is failing where it matters.
3. **A certifier demands replayable proof artifacts.** Try SMT proof replay first: it answers
   the same auditor without changing the language.
4. **Refinement types start feeding the prover.** Range-refined aliases (`i32(0..50000)`)
   propagated into SMT as assumptions is types informing proofs, one model, no proof terms.
   That is the principled way to get propositions into types here: the user writes a
   predicate, never a proof.

## See also

- [verification-roadmap](verification-roadmap.md) — what the prover does today and next
- [ownership-model](ownership-model.md) — why a stored borrow is not available to witnesses
- [milo-idioms](milo-idioms.md) — the witness, brand and typestate patterns
