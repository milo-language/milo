<!-- doc-meta
system: aliasing-coverage
purpose: kill the recurring "rule covers one spelling, not its siblings" defect class in the checker
key-files: src/checker.ts (placesOf, freeze/unfreeze), tests/errors/forInField*.milo, tests/aliasingSpellings.test.ts
update-when: a phase lands, a new aliasing rule is added, or a new leak of this class is found
last-verified: 2026-08-16
-->

# Aliasing coverage: making rule coverage mechanical

## The defect class

Every use-after-free found in this compiler in safe code has had the same shape. It is
not eight bugs, it is one bug with N front doors:

> An aliasing rule is implemented against a **node kind** rather than against a
> **place**, so it covers the one spelling its author was looking at and silently
> exempts every sibling spelling.

Confirmed instances (2026-08-16, all ASan-verified heap-use-after-free in safe code with
zero `unsafe`):

| Spelling | Before | Rule that missed it |
|---|---|---|
| `for x in v { v.push(..) }` | rejected | — |
| `for x in b.items { b.items.push(..) }` | **UAF** | for-in freeze keyed to `kind === "Ident"` |
| `for x in b.items { f(b) }` where `f(&mut Bag)` | **UAF** | same |
| `for k,v in r.m { f(r) }` where `f(&mut Reg)` | **UAF** | hashmap arm, same key |
| `for s in h.a { f(h) }` (fixed array) | wrong value read | array arm, same key |

Earlier instances of the identical shape, already closed: move-out-of-borrow through a
fork (`return if c { d.a } else { d.b }` compiled while `return d.a` errored), the
`index-clone` lint firing only where a value was *bound* and not where it was *returned*,
and `Vec<&T>` bypassing second-class references.

The cost is asymmetric here: "no use-after-free in safe code" is the product. A missed
spelling is not a papercut, it is the guarantee failing.

## A sibling class: checker and codegen disagreeing

Probing the spellings above turned up a second shape worth naming separately, because the
gate for it is different. Here both sides had a rule, and the rules disagreed:

- The checker treats a pattern-consumed enum subject as **moved** (`match o { Some(r) => …}`
  then using `o` is rejected as use-after-move).
- Codegen zeroed the payload but left the SUBJECT's drop glue armed, so a user `Drop` impl
  ran a second time on the zeroed value.

Only types whose fields are all Copy showed it: a heap field's second free is a no-op on a
zeroed pointer, which is why it hid for so long. `std/http`'s `Socket { fd: i32 }` is
exactly this shape, and there the spurious second drop is `close(0)` — closing stdin on a
socket that was already moved away. `std/mem`'s `MappedMemory { ptr: i64, len: i64 }` is
the same shape. Fixed 2026-08-16 by clearing the subject's alive flag inside the consuming
arm; locked by `tests/fixtures/matchConsumesSubjectDrop.milo`.

A second instance of the same class, found by counting rather than by accepting/rejecting:
a struct's drop glue decided "was this moved out of and zeroed?" by probing ONE field's
data pointer. An empty container defeats that probe — `Vec.new()` that never grew has a
null data pointer and is perfectly alive — so a struct whose first heap field was an empty
Vec skipped its entire destructor, user `Drop` impl included. Improved 2026-08-16 to
consult every heap field (a moved-from struct has all of them null) and to let a non-zero
integer field vouch for liveness alongside them.

**The JS backend implemented no destructors at all**, so every fixture with a `Drop` impl
(`dropAccounting`, `dropWithFields`, and the two added here) diverged under it and was
carried in its parity baseline. That backend was removed 2026-09-21; the native backend is
the only implementation of drop glue now.

**Residual, recorded rather than papered over:** a struct whose fields all read as zero —
`Res { id: 0, v: Vec.new() }`, or one whose only field is an empty container — still cannot
be told apart from a moved-from one BY VALUE, and its destructor is still skipped. Deciding
that needs a liveness flag rather than a value probe. Note the flag must not be applied
where no heap field exists: a struct with only scalars had no probe and dropped
unconditionally, which is correct, and gating it on `id != 0` silently skipped every
`Tracked { id: 0 }` (caught by `tests/fixtures/dropAccounting.milo`).

The lesson for Phase 2: routing every rule through `placesOf` fixes the checker's half of
this class and nothing else. Where codegen re-derives an ownership fact the checker already
computed, the two drift, and the drift is invisible to a suite that only checks whether a
program is accepted. Drop counts, not accept/reject, are what catches it.

## What already exists

`placesOf(e: Expr): Place[]` in `src/checker.ts` is the right primitive and is already
total over the `Expr` grammar:

- `Place` is `path` (root + steps) | `value` (fresh, aliases nothing) | `opaque`
  (unnameable — callers must read as *may be any place*).
- The switch has **no `default:`** and ends in `const _exhaustive: never = e`, so adding
  an AST node is a tsc error until it is classified.
- It returns a **set**, because control flow forks; a caller must satisfy its rule for
  every member.

The problem is not the primitive. It is that only ~12 call sites route through it, while
the checker still contains dozens of rules that switch on `expr.kind` directly. `placesOf`
being total does nothing for a rule that never calls it.

## The four phases

### Phase 1 — hoist the for-in freeze (this is the live UAF)

One freeze, computed from `placesOf`/`accessPath` on the iterable, taken **before** the
per-type dispatch and released after it. Every iteration shape — vec, hashmap, array,
string, user iterator, and any shape added later — inherits it instead of re-deriving it.
Removes four ad-hoc `kind === "Ident"` blocks.

**Done when:** the five rows in the table above are rejected, benign field iteration
(mutating a *different* field of the same struct) still compiles, and fixtures lock both
directions.

### Phase 2 — route the remaining rules through `placesOf` — **DONE 2026-08-16**

Five rules converted. Three of them (`checkStringViewForIn`, the slice-view expression and
the string-view expression) each carried their own copy of

    let root = e.object;
    while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
    if (root.kind === "Ident") { … }

which is the for-in bug one step deeper: two known ways to reach a root instead of one, so
a place spelled any other way resolved to nothing and the freeze did not happen. All three
now call `freezeRootOf`, which resolves through `accessPath`/`placesOf`. `markPlaceRead`
carried a fourth copy and is converted too, so reading `o!.field` now marks `o` read
instead of leaving the binding looking unused. The iterator-mutability check asked the
SPELLING (`iterable.kind === "Ident"`) and so never ran for `for x in self.cursor`; it now
asks the place. One subtlety that fixture `forInRvalueIterator` caught immediately: only a
NAMED root can be immutable, because an rvalue iterable is materialized into a temp and a
temp is mutable, so the check applies only when `accessPath` finds a root.

The 12 sites that remain are genuinely about a NAME rather than about storage — the base
case of a recursive walk, or a question about how a binding was DECLARED (`is this
parameter a &T?`). Each now carries its reason inline, enforced by Phase 3.

#### Original scope


Inventory every rule that answers "what storage does this expression reach" and convert
it. The ad-hoc walkers to eliminate or reduce to thin wrappers: `accessPath`,
`borrowBasePath`, `staticFieldPath`, `isRootMutable`, `freezeViewSource`,
`errorIfFrozen`, `setAutoBorrowChecked`, `checkViewProvenance`.

Two known traps, both learned by breaking them:

1. **`placesOf` and `moveTargets` must stay separate.** `s as *u8` on a `&string`
   *reaches* the operand's storage (placesOf forwards) but *consumes nothing*
   (moveTargets does not). Collapsing them broke 12 std fixtures.
2. **`errorIfFrozen` must not run on an argument that is already a reference.** A slice
   `v[0..2]` is not competing with a freeze, it *is* one; disjointness is
   `checkCallSiteExclusivity`'s job because it compares access paths and knows
   `v[0..2]`/`v[2..4]` do not overlap, which the freeze check cannot see.

### Phase 3 — make bypass detectable — **DONE 2026-08-16**

`tests/placeRuleCoverage.test.ts` fails on any *new* site that decides which variable an
expression names by matching `Ident` and then calling `lookup`, unless the reason is
written at the site as `ident-ok: <why>`. Verified non-vacuous by deleting one marker and
watching it fail with the right line. The census went 17 sites -> 12 explained, and a
thirteenth cannot be added silently.

This is the property that was missing: `placesOf` being total did nothing for a rule that
never called it, and now not calling it is the thing that has to be justified.

#### Original scope


A total walker does not help if a new rule simply does not call it. Add a gate that fails
when an aliasing-relevant rule reaches for a node kind instead of a place. Cheapest honest
version: a test that reads `src/checker.ts` and fails on `.kind === "Ident"` inside the
freeze/borrow/move regions, with an explicit allowlist carrying a reason per entry — the
same shape as the soundness manifest, so exemptions are written down rather than implied.

### Phase 4 — a spelling matrix, generated not remembered

The real fix for "did I cover every spelling" is to stop answering it from memory.
Generate the cross product of

- **container**: `Vec<T>`, `HashMap<K,V>`, `[T; N]`, `&[T]`, `string`, user iterator
- **root**: local, struct field, nested field, index element, `self` field
- **mutation route**: direct method, direct assignment, through `&mut` fn, through a
  method on the owner, inside a closure

and assert each combination is rejected (or accepted, where disjoint). A new container or
a new root spelling adds a row; a rule that only covers one spelling fails the matrix
immediately instead of years later under ASan.

**A second rule matrixed 2026-08-16**: `tests/moveOutOfBorrowSpellings.test.ts` crosses 7
ways of SPELLING a place reached through a borrow (field, nested field, fixed-array
element, Vec element, and three shapes of fork) with 5 positions that consume it (returned,
bound, passed as an owned argument, stored in a struct literal, pushed into a Vec), plus
the same 7 spellings out of an OWNED root, which must all be legal — without that half the
matrix would be satisfied by a checker that rejects every field access.

The measured answer: every field-shaped spelling errors, including through a fork and an
unwrap, and every index-shaped one silently deep-clones. That split is Tier 1 #7 and is a
filed decision rather than a hole, so it is PINNED here in both directions: changing it
shows up as a diff in this file, and a newly added spelling cannot quietly inherit
whichever branch it happens to hit. A fork whose tails MIX the two answers errors, which is
the conservative direction.

Lives in `tests/aliasingSpellings.test.ts`. Note the neighbouring
`tests/aliasingMatrix.test.ts` is a *different* axis — a golden matrix over containers x
operations, checking that each container's behaviour is written down rather than
inherited from whichever code path it hits. The two are complementary: that one varies
the operation, this one varies the spelling.

## The same habit outside the checker

Routing every rule through `placesOf` fixes the checker's half of this and nothing else.
The habit is "a rule enumerated over node kinds, with a sibling forgotten", and the checker
is only where it was noticed first. Three instances landed on the same day in three other
files:

| where | what was forgotten | cost |
|---|---|---|
| `codegen.ts isOwnedTempExpr` | `VecRemove`, while its sibling `VecPop` was present | `v.remove(0)` discarded destroyed nothing |
| itable layout | no destructor slot at all | a value behind a boxed interface was never destroyed |
| `parser.ts` array type | built from the inner type's NAME alone | `[[i64; 2]; 2]` silently meant `[i64; 2]` |

**Gated 2026-08-16 for the first of the three.** `isOwnedTempExpr` classified 33 of
`HIRExpr`'s 103 kinds and the other 70 fell off the bottom of the switch as an implicit
`false` — so nobody ever had to decide, which is how the sibling was lost. Those 70 are now
named in an exported `NOT_OWNED_TEMP`, and `tests/ownedTempCoverage.test.ts` requires every
kind to appear in exactly one of the two lists. Verified by adding a node to `hir.ts` and
watching the gate name it. The list is imported by the test rather than scraped, so it
stays referenced code instead of a comment nobody is obliged to keep.

**All three are now gated (2026-08-16).** The parser's type construction is covered by
`tests/typeAnnotationFidelity.test.ts`, which asks whether a value of the WRONG shape can
satisfy an annotation. The itable is covered by `tests/itableDropSlot.test.ts`, which reads
the emitted IR and requires every `@itable.*` to end in a destructor slot — filled for a
type that has one, null for a type that does not — across two interface arities so a
hardcoded count cannot pass by accident. Neither had an enumeration to diff against, which
is why both are property assertions rather than coverage lists.

**A fourth instance, created by the fix for the third.** Combinator callbacks were checked
at 20 sites and nothing forced the 21st. Censusing `cbHint` construction found it
immediately: `fold` validated its callback's RETURN against the accumulator and never its
parameters, because its callback is `args[1]` rather than `args[0]` and the mechanical fix
had matched `args[0]`. `fold(0, (acc: i64, x: &string) => acc + x.len)` over a `Vec<i64>`
folded garbage. Now gated by `tests/callbackSigCoverage.test.ts`.

That is worth stating plainly: a fix applied across N sites is itself an enumeration, and
inherits exactly the defect it was fixing. The gate has to land in the same change as the
fix, not after it.

## The gates inherit the defect too

Three ticks in a row, the thing that turned out to be incomplete was the most recently
*finished* piece of work:

1. Callback signature checking was applied at 20 sites; nothing forced the 21st. `fold`
   was already broken, because its callback is `args[1]` and the fix had matched `args[0]`.
2. `placeRuleCoverage` was written to catch "match `Ident`, then look it up". It matched
   one spelling and missed two others: `!== "Ident"`, and hand-rolled root walks that never
   call `lookup`. Generalizing it surfaced **9 sites the gate had been passing**, three of
   them real aliasing rules (`freezeViewSource`, `borrowDuringCallback`, `errorIfCopyBind`).
3. The scan WINDOWS were themselves fixed constants. `ownedTempCoverage` read 4200
   characters of a body already 3834 long — 91% consumed — so the next case label added
   past that point would have fallen outside the scan silently. Now brace-matched to the
   method's real end; `callbackSigCoverage` is bounded by the arm rather than by 14 lines.

The rule this yields, and it is the useful one: **an enumeration inherits the defect it
enumerates, and a gate is an enumeration.** A fix applied across N sites, and the gate
written to protect that fix, are both lists someone wrote from memory. Neither is finished
until something mechanical says what is missing — which means the gate has to land in the
same change as the fix, and the gate's own reach has to be derived rather than guessed.

## Grade criteria

The compiler is at **B** because of this class alone. What **A** requires, concretely:

1. No aliasing rule keyed to a node kind (Phase 2 complete, Phase 3 gating it).
2. The spelling matrix green and covering every container × root × mutation route
   (Phase 4).
3. A new `Expr` kind or a new container type inherits every existing aliasing rule by
   default, and the way to *escape* a rule is an explicit, written exemption.
4. The same discipline outside `src/checker.ts`. One of the three known instances is gated
   (`isOwnedTempExpr`); the itable drop slot and the parser's type construction are fixed
   but ungated.

Until 1–3 hold, the honest position is that the next spelling nobody thought of is
already broken, and it will be found by a user rather than by a gate.
