<!-- doc-meta
system: concurrency
purpose: the plan for true parallelism in safe Milo: parallel scopes under the exclusion rule, lexical locks with levels (no deadlock), lock invariants proved by induction; decisions and trade-offs
key-files: docs/concurrency-simplification.md, docs/semantics/milo.md, std/sync.milo, std/runtime.milo
update-when: a step below ships, or a decision is revisited
last-verified: 2026-11-03 (plan; nothing built)
-->

# Parallelism in safe Milo

Goal: OS-thread parallelism where data races, lock-order deadlocks and broken shared
invariants are compile-time errors. Rust's safe subset catches the first. This plan targets all
three for application code, and accepts `unsafe` std code for concurrency libraries.

## The four pieces

1. **Parallel scopes, checked by the exclusion rule.** `parallel { a(&mut x.left); b(&mut x.right) }`
   is checked exactly like one call with several `&mut` arguments (T-EXCL in
   docs/semantics/milo.md). There's no `Send`/`Sync`: a reference can't outlive the scope,
   because references never outlive a call. This needs dynamic `n`-way windows (roadmap:
   dynamic `splitMut`) for data-parallel loops.
2. **Lexical locks with levels.** `Mutex<T, L>`, accessed only through `m.with((v: &mut T) => ...)`.
   The guard is a reference, so it can't be stored or returned, and every critical section is a
   lexical block. The checker allows `with` on level `L` only while every held lock is below `L`.
   Lock order can't form a cycle, so there's no deadlock from locks.
3. **Lock invariants by induction.** The protected struct's `invariant` is assumed on entry to
   every `with` block and owed on exit. The constructor establishes it. By induction over every
   critical section, it holds in every reachable state under every interleaving. Each step is
   sequential reasoning that `milo prove` already does (struct invariants are assumed at use and
   owed at `&mut`).
4. **Atomics** default to sequentially consistent. Weaker orderings need `@unsafe` or a proof.

## Decisions (2026-11-03)

- **No hand-over-hand locking in safe code.** Non-lexical guards would make lock-order checking
  a flow analysis instead of a nesting check. Concurrent lists/B-trees live in `unsafe` std.
- **Same-level multi-locks via `withBoth`/`withAll`, sorted by address at runtime.** Banning
  them would push ordinary code (transfers between two accounts) into `unsafe`. The sort is one
  small trusted rule inside std.
- **`with` first; the monitor form `with m when cond { ... }` only when a real program needs to
  wait inside a lock.** Channels cover most waiting today.

## What this does not give

- Deadlock freedom through channels: needs the channel wait-graph rule (separate).
- Freedom from starvation or livelock.
- Lock-free structures in safe code (they need stored references), so they go in `unsafe` std.
- Work stealing: tasks never migrate (multicore design A), so load can be imbalanced.
- Invariants that need quantifiers wait for quantifier support in `milo prove`.

## Order

1. Multicore phase 3 (one scheduler per core), so tasks run on real OS threads.
2. `parallel` scopes on the exclusion rule.
3. `Mutex<T, L>` with lexical `with` and the lock-level rule; `withBoth`/`withAll`.
4. Lock invariants: an "owed on exit" obligation in src/verify.ts.
5. The channel wait-graph rule; schedule exploration in the interpreter for laws.
