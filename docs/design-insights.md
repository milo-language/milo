<!-- doc-meta
system: design-insights
purpose: durable arguments and framings for external writing about Milo (talks, posts, README)
key-files: docs/ownership-model.md, docs/memory-safety-vs-rust.md, docs/concurrency-safety.md, src/checker.ts
update-when: a design argument is validated or falsified by shipped work, or a claim here goes stale
last-verified: 2026-09-19
-->

# Design Insights

Claims about *why* Milo is shaped the way it is, kept separate from the reference docs
because these are arguments, not specifications. Each one must stay falsifiable: if the
supporting mechanism changes, the entry gets corrected or deleted, not softened.

## The constraints keep paying out in places nobody designed for

Second-class references were chosen for one reason: to get memory safety without lifetime
annotations. A `&T` that cannot be stored, returned, or captured needs no lifetime, because
it cannot outlive the call it appears in.

That single constraint has since paid out three more times, in areas it was not aimed at:

1. **It deletes most of the reason `Sync` exists.** In Rust, `Sync` primarily answers "is it
   safe to share `&T` across threads?" That question exists because Rust's `&T` is
   first-class: storable, returnable, holdable across an await point. Milo's is none of
   those, so an entire category of data race is not *prevented by a rule*, it is unwritable.
   Count of `Send`/`Sync` in Milo user code: zero. Six `unsafe impl`s exist, all in
   `std/sync`, all on primitives.

2. **It forces the better `Mutex` API.** A lock guard cannot be returned from `lock()`,
   because a guard is a reference and references are second-class. So the only expressible
   design is scope-bound: `m.lock(|v| { ... })`. That accidentally eliminates guard-held-
   across-await, `mem::forget(guard)`, and guard-outlives-scope. No unwinding means no
   poisoning either, so `PoisonError` never enters a signature. Rust's `MutexGuard` permits
   all of those and pays for it in every caller's types.

3. **It makes the data-race surface enumerable.** Green tasks run on a single-threaded
   cooperative scheduler and cannot race at all. Every data race in every Milo program must
   therefore pass through one of two doors: `Promise.blocking` or `spawnOsThreadDetached`.
   That is a *list*, and it is now literally a list in the compiler (`@thread`, read by
   `checkThreadBoundary`). In Go the surface is every goroutine and there is no list to
   write.

   The caveat: "cannot race" is not "cannot dangle". A cooperative switch is still a
   switch, and a for-in binding, slice, or `&` into a mutable global is a pointer into a
   buffer another task may realloc while this one is parked. That was a real
   use-after-free (`for x in g { schedulerYield() }`), and it has its own door: `@parks`,
   rooted at `swapcontext` and derived transitively, with the rule that no element view of
   a mutable global may be live across a call that may park. Same shape as `@thread`: one
   declared boundary, a walk that stops there.

The pattern worth naming: one decision made for reason A turning out to also solve B, C,
and D. That is the signature of a model that is coherent rather than assembled. A language
built by accreting features gets holes at the seams between them; a language built from a
small consistent core gets holes only at its edges. Both have bugs. Only one has bugs that
get rarer as you fix them.

**Falsifier.** If a future feature needs first-class references (stored closures over
borrows, self-referential structs, returned views), all three payouts unwind together. That
is the price of the position, and it is why `docs/ownership-model.md` argues against
lifetimes rather than merely omitting them.

## Safety rules are only tenable with an ergonomic alternative

A rule that forbids something without naming the replacement does not prevent the unsafe
pattern, it relocates it into `unsafe`. Every safety check Milo adds owes a diagnostic that
names the fix, and the fix has to actually exist in `std`.

Worked example, from closing the mutable-global race: the first version of the check
rejected the canonical `Once.run` one-shot-init pattern, which is not a race but the *cure*
for one. Teaching the checker about critical sections (`@synchronized`) was not a special
case bolted on, it was the rule finally distinguishing "touches shared state" from "touches
shared state without synchronization". A false positive on correct code is usually a rule
that has not finished being written.

## Weak rules over clever ones

Related, and already recorded elsewhere as Bennett's Razor: prefer the checker rule that
assumes least. `checkThreadBoundary` deliberately stops at a `@synchronized` boundary rather
than modelling what `Once` does internally. Modelling the primitive would be more precise
and would break the first time a primitive changed. Stopping at a declared boundary is
weaker, and it means a new synchronization type only has to declare itself.
