<!-- doc-meta
system: positioning
purpose: honest account of where Rust genuinely wins over Milo, and the claims Milo may and may not make
key-files: docs/ownership-model.md, docs/memory-safety-vs-rust.md, docs/design.md, std/arena.milo, std/seal.milo, std/shard.milo, std/json.milo
update-when: the residue changes (a feature lands that closes one of the three gaps, or the safe-claim boundary moves)
last-verified: 2026-09-19
-->

# The residue: where Rust genuinely wins

This document exists so every later design decision stays honest about what Milo is and isn't trying to be. Users will find these gaps themselves. Naming them first is cheaper than being caught denying them.

Milo's axiom is that **values are closed**: nothing aliases in, nothing escapes out. References are second-class (see [ownership-model](ownership-model.md)). That axiom buys a great deal — no lifetimes, structural disjointness, cheap proofs. It also has a residue: three workloads where Rust's ability to *keep* references safely is a real advantage Milo does not match. These are not bugs. They are the price of the axiom.

**Where this stands as of 2026-08-22.** All three residues have had their most common workload
taken out of them by the same idea, and none of it needed a new language rule. Where Rust proves a
property of a reference, Milo removes the operation that could violate the property, and the move
checker proves the removal:

| Residue | Rust proves | Milo removes | Mechanism |
|---|---|---|---|
| 1 staleness | a stored reference never goes stale | removal (`free`/`clear` do not exist) | `Arena.freeze` |
| 2 aliasing | disjoint `&mut` borrows | aliasing (ownership divides) | `parallelMap` and friends |
| 3 invalidation | a borrow outlives its referent | mutation (no mutating method exists) | `seal` + `Span`, branded `json` cursors |

Each section below says what its mechanism closed and, at more length, what it did not. The residue
did not disappear; it split into a compile-time half and a smaller runtime-checked half, and naming
that second half is what these sections are now for.

## 1. Compile-time rejection of stale stored references

Rust proves at compile time that a stored reference never outlives its referent. Milo forbids storing references at all, so the question never arises for references — but the *need* doesn't vanish. Graph-shaped, stored, or long-lived data goes through pool indices and generational handles ([SlotMap](std/) is the blessed collection). A stale handle is caught **at runtime** as a deterministic error, never as silent aliasing or UB.

**The build-then-read majority now gets the compile-time answer** (2026-08-22). `Arena.freeze()`
consumes an arena and returns a `FrozenArena<T>` on which `alloc`, `free` and `clear` do not exist.
Every handle the arena minted is therefore still live, so `get` returns `T` rather than
`Option<T>`: no generation check, no liveness check, nothing to unwrap at the call site. The proof
is the move checker that already shipped, not a new rule. Touching the old arena binding afterwards
is `error: use of moved variable 'a'`.

The scope of that claim is exact. `freeze` is **refused** for an arena that ever freed a slot, and
the refusal hands the arena back (`FreezeRejected<T>`). It has to be: a freed-then-reallocated slot
leaves stale handles naming a live slot that now holds a different value, and a `get` with no
generation check would return that value as though it were right. Arenas that genuinely free and
reuse keep their generational checks and stay exactly as described above. So the residue does not
close here, it splits: build-then-read is now compile-time, free-and-reuse is still runtime-checked
and still waiting on the contracts profile. Two checks also survive `freeze` and are not about
staleness at all, a handle from a different arena and an index past the end; both abort with a named
message rather than read unrelated memory.

For most code, runtime-deterministic is fine. For TLS session state, kernel objects, or a DB engine's page table — where a stale-handle panic in production is itself unacceptable — Rust's compile-time rejection is genuinely stronger. Milo's answer to that tier is the contracts profile (see [verification-roadmap](verification-roadmap.md)): prove `pool.contains(h)` statically and the runtime check is elided. Until a given call is proven, it runs checked. That is graceful degradation Rust's all-or-nothing signature can't offer — but the *default* is a runtime check, and honesty requires saying so.

## 2. In-place shared-memory parallelism

`par_iter_mut`, scoped threads carving one array into disjoint mutable slices, work-stealing over shared state — Rust checks these safe. Milo **bans the workload** rather than checking it. There is no `&mut [T]` split into aliasing-free sub-slices across threads (see backlog: mutable slice split). Multicore scaling is Node-style: processes, message passing, `Promise.blocking` workers that move-capture their inputs.

**Divisible ownership now covers the in-place case** (2026-08-22, `std/shard`). Rust proves that
several `&mut` slices into one buffer are disjoint. Milo does not prove it, because it makes the
ownership itself divisible: `parallelMap` CONSUMES a `Vec`, divides it into disjoint owned
windows, and each worker receives one by move like any other value. No reference crosses a
thread. The aliasing argument is the move checker that already shipped, plus `@noCopy` on the
window, so handing the same window to two workers is a compile error rather than a race.

Measured on a 10-core machine, 20M `f64`, 4 workers, against the C program doing the banned thing
(pthreads over one shared buffer): Milo 3 ms / 163.0 MiB, C 3 ms / 154.0 MiB, Milo sequential
6 ms / 153.9 MiB. Times at this size are bandwidth-bound and move around in the 3-7 ms band run to
run; the memory figures are stable to a tenth of a MiB. The copy tax is gone; what remains is a flat 9.1 MiB of worker stacks, the same
fixed cost at 40M elements. Reproduce with `sh benchmarks/shard/run.sh`.

What closed on 2026-09-19, and what it cost: a window is a pointer into the owner's buffer, and
dropping the owner while a worker still held a window was a use-after-free nothing caught (the
sweep's H2). Until then the manual `shatter`/`windows`/`weld` path was offered with a "keep the
owner alive until weld" obligation and a runtime completeness check that could only notice a miss
after the fact. That path is now private to `std/shard`. Every public form (`parallelMap`,
`parallelMapWith`, `parallelScanStr`) creates every window, hands out every window, awaits every
worker and reassembles inside one call, so no caller code exists in which the owner can die first:
completeness follows from the shape of the call. It is the same guarantee Rust's scoped threads
get from lifetimes, reached by closing the cycle inside one function rather than by proving a
lifetime. The cost is expressiveness, not soundness: the windows are never yours to hold apart,
so a worker pool you drive yourself, stencils with overlapping halos, true 2D tiles, and
long-lived contended shared state all remain outside what dividing ownership can do.

For a parser, CLI, or service this is the right trade and often faster to reason about. For a physics kernel, an ECS inner loop, or a tiled image filter that must share one buffer across cores, Rust does the thing Milo won't. Don't pretend the process model covers it — it covers throughput, not shared-memory data parallelism.

## 3. Stored zero-copy

Borrowed ASTs, zero-copy deserializers, a `struct` holding `&str` slices into an input buffer — Rust stores those borrows and proves them valid. Milo can't store a reference, so its zero-copy story is **offset pairs into an owned buffer**: hold the buffer, carry `(start, len)`, resolve on access. Views (`&[T]`/`&str`, second-class) delete the *transient* clones — passing a sub-slice down a call — but a structure that must *retain* a view over a buffer it doesn't own is the stored-borrow case again, and the answer is offsets.

**Consuming the buffer into an immutable type covers the retained-view case** (2026-08-22,
`std/seal`). A stored view is dangerous for exactly one reason: the buffer can change under it. So
`seal` consumes a buffer into a `Sealed` on which no mutating operation exists. Offsets kept
against it (`Span`: two integers, `Copy`, storable anywhere) cannot be invalidated, because no
operation that could invalidate them exists. Mutation is not rejected by a check that might have a
hole in it; it is absent from the type. There is no `unsafe` in the module.

What does NOT close at compile time: nothing ties a `Span` to the buffer it was
measured from, or a `json` cursor to the document it was navigated in. Rust
rejects that mix-up outright with an invariant lifetime; binding it statically
needs a lifetime or a type-level brand, and neither exists under the axiom. Both
types therefore carry a runtime brand instead (`Span._bufferId`,
`Json._docId`): resolving against the wrong owner is a named abort, never
wrong-but-in-bounds data. That is the demotion discipline below applied to the
pattern's own gap, a runtime demotion rather than a compile-time rejection.
Buffers that must keep mutating while views are held (an editor's rope, an
incremental parser's live text) stay on offsets-by-convention.

## The claim discipline

Never say indices eliminate memory bugs. The correct claim, always:

> Pool indices and generational handles **demote memory-unsafety** (UB, corruption, exploitability) **to logic bugs** (wrong value, deterministic panic). SlotMap and newtyped keys then catch most of *those* too.

A wrong index is still a bug. It is a bug that crashes deterministically or returns the wrong value — not one that corrupts the heap or becomes a CVE. That demotion is the whole safety pitch. Overstating it to "no bugs" forfeits the credibility the honest version earns.

## Target and anti-target

**Target:** parsers, CLIs, services, leaf libraries — code where ownership is mostly a tree, references are mostly transient, and the pool/handle/message-passing style is what expert Rust converges on anyway. Milo makes that style primary and deletes the machinery that served the other style.

**Anti-target:** event-loop runtimes with GC-managed FFI, SMP monoliths and other shared-memory data-parallel workloads, systems that must store zero-copy borrows across a buffer's lifetime. Milo can be *used* there, against the grain, but it is not competing to win there.

Note "kernels" is *not* on this list. Freestanding/no-runtime is shipped, and a single-core RTOS core needs no shared-memory parallelism — interrupt masking is the lock. The anti-target is the *SMP* part, not the bare-metal part. See [kernel-feasibility](kernel-feasibility.md).

## The pitch, stated correctly

Not "Rust minus annotations." It is: **the pool / handle / message-passing style that expert Rust code converges on anyway, made primary, with the machinery that mostly served the other style deleted.** The three items above are what that machinery was for. We removed it on purpose, and we say what it cost.

## See also

- [ownership-model](ownership-model.md) — why references are second-class
- [memory-safety-vs-rust.md](memory-safety-vs-rust.md) — the empirical threat matrix
- [verification-roadmap](verification-roadmap.md) — the contracts profile that narrows residue #1
