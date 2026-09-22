<!-- doc-meta
system: contract-frames-plan
purpose: add an assigns clause (the frame / write set) to the contract language, required only where a contract already exists, and say why mandatory-everywhere was rejected
key-files: docs/verification-roadmap.md, src/verify.ts, src/prove-milo.ts, src/contract-tests.ts, src/parser.ts, docs/grammar.ebnf
update-when: assigns ships, the required-where rule changes, or the site census below goes stale
last-verified: 2026-09-22
-->

# Contract frames (`assigns`)

Milo's contract language has four verbs: `requires`, `ensures`, `invariant`, `decreases`,
plus `old()` and `result`. A function contract has three parts, and Milo has two of them:
a precondition, a postcondition, and a **frame** naming what the call may write. CBMC
(`__CPROVER_assigns`), ESBMC (`__ESBMC_assigns`) and Kani (`#[kani::modifies]`) all carry
the third. Milo does not.

## What the gap costs today

1. `milo test --contracts` skips every `&mut` parameter it cannot build, with the message
   "the harness has no way to state what it may change". That sentence is a description of
   a missing `assigns` clause.
2. The prover **infers** a frame instead of reading one: a call site gets a frame
   assumption relating post-call havoc symbols to pre-call ones, and a havoc that no
   contract, guard or invariant describes is reported `unknown` rather than `failed`. A
   declared frame turns a class of those `unknown` verdicts into real ones.
3. `old()` is scalars-only. You cannot snapshot what you cannot name, so the frame is the
   prerequisite for widening it.

## Rejected: required on every `&mut` function

Census of the tree on 2026-09-22:

| | `&mut` free fns | `&mut self` methods | total | already carry a contract |
|---|---|---|---|---|
| `std` | 78 (19 `pub`) | 130 | 208 | **21** |
| `examples` | 853 (440 `pub`) | 216 | 1069 | **4** |
| `src-milo` | 398 | 0 | 398 | 0 |

Requiring `assigns` on every `&mut` function is ~1277 annotation sites outside the parked
self-host tree, 459 of them on `pub` signatures, to serve 25 contracts. Most of the burden
lands on `examples/`, which is teaching material: every sample program would grow
verification ceremony unrelated to what it demonstrates. It also contradicts the
verification roadmap's stated guiding principle, "static analysis first, no annotation
burden ... Verification must not turn Milo into a proof-obligation grind".

## The rule: required only where a contract already exists

- A `&mut` function with no `requires`/`ensures` keeps the **inferred** frame. Nothing
  changes, no annotation, no migration.
- A `&mut` function that carries a `requires` or an `ensures` **must** declare `assigns`.

This is a ratchet: the required set can only grow, and it grows exactly when someone asks
for a proof. Nobody pays for a frame on code that never wanted verification.

### Migration: the whole required set, today

21 sites in `std`, 4 in `examples`. Three are platform arms of one `Pty.spawn` and four are
method wrappers restating a free function's contract (`Pool.free`/`poolFree`,
`Pool.reset`/`poolReset`, `Bump.alloc`/`bumpAlloc`), so there are about **17 distinct
frames to author**.

```
std/mem.milo       bumpAlloc, bumpReset, Bump.alloc
std/pool.milo      poolAlloc, poolFree, poolReset, Pool.free, Pool.reset
std/arena.milo     arenaAlloc, arenaFree, arenaClear          (generic: prover only)
std/inflate.milo   bits, _decode, construct, codes, stored
std/sort.milo      qsortI64, qsortI32
std/pty.*.milo     Pty.spawn (darwin, linux, windows)
examples/          kvstore put, kvstore scanNext, pidUpdate, physicsTick
```

That set is almost exactly the code with its own memory management (`Bump`, `Pool`,
`Arena`), which is where a frame pays best and where a wrong frame would hurt most.

### Syntax

```milo
fn bumpAlloc(a: &mut Bump, size: i64): Result<i64>
requires size > 0
assigns a.used
ensures ...
```

- `assigns a` names the whole object behind `a`.
- `assigns a.used, a.data` names fields.

Whole-object is one token, so the lazy form stays cheap. It is **not** vacuous: it still
claims "and nothing else", which is the half that catches a function quietly writing a
global or a second parameter. That is the half worth having even when the field list is
not worth maintaining.

## The cost that is not the annotations

`assigns` has to be two-sided, for the reason the roadmap already gives for struct
invariants: "assumed at every use, owed at every literal and every `&mut` function, because
the assume half alone is an unchecked hole". A frame assumed at call sites but never
checked against the body is worse than no frame, because the prover would then trust it.

**Shipping `assigns` means shipping the body-side check.** The 17 annotations are noise
next to that. Estimate the body check before scheduling the syntax.

## Open

- Does the required set include a `&mut` function whose only contract is a loop
  `invariant` inside the body, or only `requires`/`ensures` on the signature?
- Wrapper duplication: `Pool.free` restates `poolFree`'s preconditions today and would
  restate its frame too. Worth a way to inherit a callee's contract rather than copy it.
- `assigns` interaction with the generic `std/arena` functions, which the property-test
  harness cannot draw but the prover can reason about.
