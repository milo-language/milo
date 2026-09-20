<!-- doc-meta
system: memory-safety-vs-rust
purpose: adversarial retained probes of Milo's safe-language behavior compared with Rust, the findings that broke the claim, and what the compiler does not check
key-files: src/checker.ts, src/codegen.ts, std/arena.milo, std/shard.milo, std/seal.milo, scripts/fuzz-generic-drop.ts, scripts/fuzz-tasks.ts, docs/ownership-model.md
update-when: a safety check is added/moved between compile-time and runtime, a new threat class is probed, a fuzzer finds a hole, or one of the three unchecked gaps closes
last-verified: 2026-09-20 (findings #3-#10 from the September soundness sweep; the former standalone where-Rust-wins doc folded in as the "what the compiler does not check" section; matrix rows for closure borrows, arena reads, wrong-arena handles, `@mustUse` and private fields)
-->

# Memory safety: Milo vs Rust, battle-tested

Memory safety is the whole reason a safe systems language exists, so this doc doesn't argue it — it *probes* selected threats with retained regression fixtures and both-sides receipts. The bar is simple: **no silent undefined behavior in safe code.** A threat is handled if it is caught at compile time or trapped at runtime. `unsafe`, FFI declarations, and manual `unsafe impl Send` / `Sync` are explicit trust boundaries, as they are in Rust.

Result of the retained sweep (2026-07-22): **zero silent-UB misses in the tested safe-language cases.** The sweep did find and fix cross-arena handle confusion, which returned the wrong value without memory UB, and it made manual thread-safety overrides explicitly unsafe. Overflow now traps in every build mode (finding #1, closed).

**That claim is scoped to the probes listed here, and it has been broken eight more times.**
Finding #2 was a use-after-free in safe code that none of the probes covered, found by chasing
an unrelated red test. Findings #3 to #9 came from the September 2026 soundness sweep
([plans/soundness-sweep-2026-09.md](plans/soundness-sweep-2026-09.md)): three from one
afternoon of adversarial programs, one from an independent review, two from the first run of a
fuzzer that sweep built, and one from the fix for another. Finding #10 is the prover's, not
memory. Every one of them sat at a seam between two
mechanisms (a generic `unsafe` block and a `Drop` type; an OS thread and an owner's scope; the
green scheduler and a global's buffer; a raw pointer and a `Vec` that grows), which is where
`design.md` predicts holes and where the fuzzers now look. Read the sweep as "these threat
classes are held", never as "safe Milo has no UB left."

## Threat matrix

`compile` = rejected before codegen · `runtime` = defined trap/abort · `n/a` = the pattern can't be written

| Threat class | Rust catches at | Milo catches at | How Milo does it |
|---|---|---|---|
| Use-after-move | compile | **compile** | move checker: `error: use of moved variable` |
| Double-free | compile | **compile** | second move is use-after-move |
| Use-after-free, owned (`Heap`/`Box`) | compile | **compile** | move checker — `Heap<T>` is single-owner |
| Dangling return (`return &local`) | compile | **compile** | refs are second-class: `error: cannot return a reference` |
| Stored borrow in a struct | compile (with `<'a>`) | n/a → **compile** | `error: references cannot be stored in structs` |
| Iterator invalidation (mutate while iterating) | compile | **compile** | borrow tracker: `error: cannot call 'push' on 'v' because it is borrowed`; a callee that writes the global is `'f' writes the global 'g', which is being iterated here` |
| Element view of a mutable global held across a green-task park | n/a (no globals without `unsafe`/`Mutex`) | **compile** | `@parks` walk: `'schedulerYield' can park this task while the loop variable is a reference into 'g's buffer` (finding #5) |
| Raw pointer from `ptr()`/`cstr()` outliving a realloc of its source | compile (`as_ptr` borrow ends, but the deref is `unsafe`) | **compile** | pointer holders are element views: `'v' may reallocate here while 'p' still points into its buffer` (finding #6) |
| Copying a `Drop` element out of a container by value | compile (`cannot move out of index`) | **compile** | `cannot take 'Res' out of a container by index: it carries Drop`, at every by-value site (finding #7) |
| Bitwise copy of a `Drop` `T` inside a generic `unsafe` body | compile (`T: Copy` bound) | **compile** | `@copyOnly` on the generic plus the raw type-param read rule (finding #3) |
| Owner dropped while a worker on another OS thread holds a window into it | compile (scoped threads) | n/a → **compile** | the divide/run/reassemble cycle is one call; the pieces are private to `std/shard` (finding #4) |
| `impl` method disagrees with its trait's signature | compile | **compile** | `'add' in 'impl Add for Res' takes 'self: Res' by value; the trait 'Add' declares 'self: &Self'` (finding #9) |
| Aliasing `&mut` + `&` to one place | compile | **compile** | exclusivity check at call site, including an inline `v.ptr()` beside a `&mut v` |
| Closure capturing a borrow (a `&T` parameter or a local view) | compile (the closure's lifetime is bounded by the borrow's) | **compile** | `error: cannot capture 'mid' in a closure`, hint: a closure stores its captures and can outlive the storage this points into |
| Zero-copy read of an arena slot while the arena is mutated | compile (`&'a T` out of the arena borrows the whole arena) | **compile** | no `&T` ever leaves the arena: `a.with(h, (x: &T) => R)` and `a.read(h, f)` scope the borrow to the closure, and `a` is frozen for the call, so no interior alias exists to invalidate |
| Forged struct internals (a brand, a sealed value, an arena wrapper built by hand) | compile (private fields) | **compile** | `_`-prefixed fields are file-private: `error: field '_x' of 'S' is private to 'file.milo'` |
| Discarded fallible result | compile (`#[must_use]` warning) | **compile** | `unused-result` warning on every discarded `Option`/`Result` and on a `@mustUse` function (`warning: unused result of '@mustUse' function 'g'`); an error under the DO-178C and NASA profiles |
| Use-before-init | compile | **compile** | declaration requires an initializer (parse) |
| Null deref | compile (no null; `Option`) | **compile** | no null type; `Option<T>` must be matched |
| Out-of-bounds read (array) | runtime panic | **runtime** | `milo: array index out of bounds: 5/3` |
| Out-of-bounds index (`Vec`) | runtime panic | **runtime** | `milo: array index out of bounds: 7/1` |
| Use-after-free, cyclic (arena handle) | n/a (`&'a` rejected) → runtime | **runtime** | generational `Handle`: stale handle → `get` returns `None` |
| Handle presented to the wrong arena | runtime (`slotmap` / `generational-arena`: `None` or panic) | **runtime** | every `Handle` carries its `arenaId`; a mismatch is `None` from `arenaGet`/`arenaWith` and `false` from `arenaFree`/`arenaSet`. Roles that must never mix get a compile-time brand instead: the phantom-brand idiom in [milo-idioms.md](milo-idioms.md), pinned by `tests/errors/arenaBrandMixup.milo` (`expected HandleB, got HandleA`) |
| Undelivered channel payloads leak on drop | runtime (Rust's `Drop` for the channel runs them) | **runtime** | `ChannelHandle`'s drop runs `T`'s glue on every queued slot (finding #8; a leak, not UB) |
| Divide-by-zero | runtime panic | **runtime (all modes)** | `milo: division by zero` |
| `INT_MIN / -1` | runtime panic | **runtime (all modes)** | same guard as div-by-zero |
| Integer overflow | debug panic / **release wrap** | **runtime (all modes)** | `--no-overflow-checks` (or `--fast`) opts back into wrapping |
| Contract violation (pre/post/invariant) | runtime (unstable) / external tools | **compile-time (SMT) + runtime** | different axis, see below; a havoc with no contract behind it is `unknown`, never a counterexample (finding #10) |

The last row is *not* memory safety — it's functional correctness. It's here because it's where Milo pulls decisively ahead, and it's easy to conflate the two.

## What runs in CI

The probes behind the matrix are ordinary tests: `tests/errors/` for every `compile` row,
`tests/runtime-errors/` for every trap, `tests/fixtures/` for the programs that must keep
working (the index-loop rewrite of finding #5, `channelDropsUndelivered`, `implSignatureMatches`),
`tests/prove/` for finding #10, and `tests/mustUseLint.test.ts` plus `tests/safety.test.ts` for
the discarded-result row, which is a warning outside the safety profiles. The `bun test` step of `.github/workflows/ci.yml` runs all
of them. Three later steps in the same job are what the sweep added:

- **AddressSanitizer sweep** (`bun run test:asan`): every fixture built with `--sanitize` and
  run. It ignores `tests/known-red.txt`, so a reproducer the test driver excuses still shows red
  here; that is how findings #3 to #5 were kept visible between being filed and being fixed.
- **Soundness fuzzers**: `bun run fuzz:tasks --n=100` (unsafe-free programs over mutable
  globals, `Task.spawn`, parks, `Promise.blocking`, `parallelMap` and `ptr()`, ASan as the
  oracle) and `bun run fuzz:generic-drop` (every generic `pub` std symbol instantiated with
  `string` and with a `Drop`-counting struct; ASan plus a made/gone balance as the oracle, and
  a `covered N / M` line so an unreachable symbol is reported rather than skipped). Both accept
  a checker rejection as a pass: the fuzzers hunt programs the checker accepts and ASan rejects.

A finding is closed when its reproducer is an error test, the fuzzer that would have found it
runs the shape clean, and the ASan sweep is green with the known-red list empty. All three held
at `1edda9fe` (2026-09-20).

## The cyclic-data nuance (why "runtime" isn't a downgrade there)

For a mutable cyclic graph — doubly-linked list, parent-pointer tree, DOM — Rust's `&'a` borrow checker **rejects the aliasing outright**; there is no compile-time `&'a` version to be "worse than." Real Rust reaches for one of:

- **`Rc<RefCell<T>>`** — use-after-free impossible (refcount), but `borrow_mut()` aliasing violations **panic at runtime**, plus a heap alloc + refcount per node (and cycles can leak).
- **arena + raw `usize` index** — a stale index is not caught: slot reuse can return the wrong value.
- **generational arena** (`slotmap`, `generational-arena`, or a domain-specific equivalent) — a `(slot, generation)` key rejects stale access, the same mechanism Milo uses.

Milo's `Arena<T>` + generational `Handle<T>` is safer than a raw-index arena and at parity with Rust's generational arena designs. Milo's differentiator is that this abstraction ships in `std/arena`; Rust normally uses a crate or a project-specific arena. The runnable `steelman_arena` receipt implements the same typed generational-key design on both sides.

## Where Rust is genuinely ahead: stored borrows

A type that *stores a borrow* of data owned elsewhere:

```rust
struct Parser<'a> { input: &'a [u8], pos: usize }   // Rust: compile-time view↔buffer tie
```

Milo can't express this — refs are second-class. You own the buffer and hold an integer offset instead (`std/json` does exactly this). Still memory-safe (bounds-checked), but you lose the compile-time guarantee that a view can't outlive or mismatch its buffer — a logic bug Rust's `'a` would catch. This is the central tradeoff of Milo's reference model, not a claim that Rust has no other ecosystem or expressivity advantages. See [ownership-model.md](ownership-model.md), and the section below on what the compiler does not check.

## Beyond memory safety: contracts (where Milo pulls ahead)

Memory safety stops corruption; contracts stop *logic* errors — a function fed inputs it forbids, or returning a value it promised it wouldn't. Milo has them built in:

```milo
fn clamp(x: i32, lo: i32, hi: i32): i32
  requires lo <= hi
  ensures result >= lo && result <= hi
{ if x < lo { return lo }  if x > hi { return hi }  return x }
```

- **`milo prove`** discharges these at **compile time** via an SMT solver. On the above: `proven: 2 failed: 0 unknown: 0` — the postcondition and the caller's precondition are *proven*, not tested.
- A precondition violated with **compile-time-constant arguments** is a hard compile error (`clamp(5, 100, 0)` → `error: requires clause 'lo <= hi' violated`), no prover run needed.
- In **`--debug`**, every clause becomes a runtime assert (entry/return/loop). **Release** compiles them out.

**Rust, from its own source:** `core::contracts` exists (`requires`/`ensures`, issue #128044, RFC 3484) but is **unstable**, and it lowers to **runtime** assertions (`-Z contract-checks`) — rustc ships no SMT solver. Rust can encode some invariants through newtypes/typestate and selected const assertions; general static proof uses external tools such as Kani (CBMC), Creusot (Why3), or Prusti (Viper). Milo's advantage is an integrated path for its bounded linear-arithmetic fragment.

**Honest frontier.** Milo's prover is not a general verifier. It discharges **linear scalar** arithmetic over integers at call sites and returns; it reports **`unknown`** (not `proven`) for nonlinear/bitwise expressions (`*` of two variables, `&`, `<<`), a call with no contract behind it, and struct-field loop invariants. Builtin `Vec`/`string` methods carry a contract table (`push` is `len == old(len) + 1`, and so on), so a `len` claim across one of them is decided rather than guessed. `unknown` ≠ `failed` — it means "not discharged statically," and in `--debug` that clause still holds the line at runtime. The win is real but bounded: simple numeric contracts are proven away for free; richer ones fall back to runtime. See [prover-frontier](design.md) notes.

## Finding #1 (closed): overflow wrapped in release

- **Was:** `2147483647 + 1` at `i32` wrapped to `-2147483648` under `milo run`, default `build` (-O2), and `--release`; only `--debug` trapped.
- **Now:** all three trap (`runtime error: integer overflow`), matching design.md's decided default. The checked-arith emission is decoupled from `-O`; `--no-overflow-checks` and `--fast` opt back into wrapping for a perf-critical build, `@wrapping fn` declares it per function.
- Wrapping was never UB, so this was a policy gap rather than a memory-safety hole — but it was the one row where Milo claimed more than it shipped.

## Finding #2 (closed): a non-Copy field could be moved out of a `&T`

- **Was:** `fn describe(d: &Doc): string { return d.text }` compiled. It shallow-copied the
  `String` header out of a borrow, so the caller and the real owner both owned the same heap
  buffer. With a temporary owner — `describe(parse("x"))` — the pointee was freed before the
  read, and the program printed 19 NUL bytes and was killed; with a live owner it double-freed
  at scope end. Safe code, no `unsafe`, no FFI.
- **Why the probes missed it:** the checker already rejected moving a whole `&T` binding
  (`cannot move the borrowed value out of 'x'`), and the field case was written as a
  deliberate carve-out — `tryMove`'s FieldAccess arm skipped the move-out marking when the
  base was a ref, which avoided zeroing the source but let the value escape as owned. The
  matrix tested the binding, not the field one level down. A nested `d.inner.text` was worse
  still: the one-level `expr.object.kind === "Ident"` test did not see it at all, so it was
  marked as a move and zeroed a field *through a shared borrow*.
- **Now:** both are `cannot move the borrowed value out of '<base>'`, with a hint to `clone()`.
  `borrowBaseName` walks the whole `a.b.c` / `v[i].f` chain to the root binding.
  `tests/errors/moveFieldOutOfBorrow.milo` retains it.
- **The carve-out, and the second bug it hid.** The first fix exempted *closure bodies* in
  general, on the reasoning that `users.sortByKey((u: &User) => u.name)` is the documented way
  to sort by a string field and is sound because the sort reads the key without dropping it.
  That reasoning was empirical, and it was wrong for `map`, which **retains** what its closure
  returns: `users.map((u: &User) => u.name)` compiled, built a `Vec<string>` aliasing the
  source elements' buffers, and double-freed on drop — a live abort (exit 133), reachable from
  a one-line idiom. The exemption is now keyed to `sortByKey` alone and is **fail-closed**: a
  new combinator is subject to the rule until someone proves it does not retain the value.
  `tests/errors/mapMoveFieldOutOfBorrow.milo` pins it.
- **A second lesson, about the fix rather than the bug.** The exemption's first form did not
  just fail to error — it fell through to the ordinary move path, marking the field moved, so
  codegen *zeroed the source field inside the container being sorted*. Every name came back
  empty, silently, with the sort still reporting success and the whole suite green, because no
  fixture covered a string key. `tests/fixtures/sortByKeyString.milo` covers it now. Not
  erroring and not move-marking are two separate obligations here, and only one of them is
  visible in the diagnostic.
- **What is still open:** a closure that returns a borrowed field to a *user-defined* higher
  order function is now rejected along with `map`, so the known hole is closed — but the
  soundness of `sortByKey` rests on reading `codegen-vec.ts`, not on anything the type system
  enforces. Making the key extractor's contract explicit (a borrow-returning closure type) is
  the real fix, and it is blocked on second-class refs banning `&T` returns.
- Found while chasing an unrelated failing test (`tests/mangle.test.ts`, red on main for this
  reason), which is the honest lesson: the red test was the signal, not the sweep.

## The September 2026 sweep: findings #3 to #10

Baseline `284606cc`. Sixteen adversarial programs written on 2026-09-19 against the pure
checker surface (moves, second-class refs, call-site exclusivity, closure escape, the
`@thread` boundary) found nothing there. Every hole was at a seam. Each finding below gives
the program shape, what happened at the baseline, the rule that rejects it now (message quoted
from `./milo check` on the named error test), the closing commit, and who found it.

### Finding #3 (closed): `Shard<string>` double-freed

- **Shape:** `parallelMap(data, 1, f)` over a `Vec<string>`; the worker's `s.get(i)` and
  `s.set(i, x)` read and overwrite elements through the window's raw pointer.
- **At `284606cc`:** exit 133, malloc abort. `Shard.get` did `unsafe { self.base[i] }`, a
  bitwise copy of a `Drop` `T`, so the copy and the element each freed the same block. Every
  shard fixture used `f64` or `i64`, where a bitwise copy is the right thing.
- **Now:** `error: 'parallelMap<string>' is not allowed: 'parallelMap' is @copyOnly and
  'string' is not a Copy type (it owns heap memory)`, naming the type the user wrote rather than
  the mangled instance. The dual rule inside std keeps the attribute honest: a generic body
  that reads a `*T` element by value without `@copyOnly` gets `error: reading 'T' by value
  through a raw pointer copies it bitwise; 'T' may own memory`. Every other `unsafe` block in
  a generic std fn was audited against the same question (the audit table is the header of
  `std/shard.milo`); this module is the only one that needed the attribute.
  `tests/errors/shardStringRejected.milo`, `tests/errors/rawTypeParamReadNotCopyOnly.milo`.
- **Commit:** `b647ee2d`. **Found by:** the 2026-09-19 battle test (H1).

### Finding #4 (closed): the shard owner could die under a worker

- **Shape:** `var owner = shatter(data, 1); let w = owner.windows().pop()!`, hand `w` to a
  `Promise.blocking` worker, return the promise; `owner` drops at the end of the function while
  the worker is still writing through `w`.
- **At `284606cc`:** the worker wrote `2.0` into a freed buffer; a fresh `Vec.filled(n, 9.0)`
  that reused the block printed `2`, not `9`. The move checker cannot see it because nothing is
  moved twice, and the `weld` completeness check can only notice a miss after the fact (a
  program that never welds never reaches it). The docs carried a "keep the owner alive until
  weld" obligation instead of a rule.
- **Now:** the obligation is gone, not enforced: `shatter`, `shatterStr`, `Shards`, `StrShards`
  and their `windows`/`weld`/`reclaim` are private to `std/shard`. The public forms
  (`parallelMap`, `parallelMapWith`, `parallelScanStr`) make every window, await every worker
  and reassemble inside one call, so no caller code exists in which the owner can die first.
  The reproducer is `error: 'shatter' is private to shard.milo`
  (`tests/errors/shardsManualPathPrivate.milo`). Decision recorded in the plan: no new
  attribute; un-`pub` costs no vocabulary and deletes the surface. Census before the change:
  0 examples, 4 fixtures, 3 benchmarks used the manual path; all rewritten onto the closed forms.
- **Commit:** `1ad69973`. **Found by:** the 2026-09-19 battle test (H2).

### Finding #5 (closed): a for-in over a mutable global across a yield

- **Shape:** `var g: Vec<i64>`; one task runs `for x in g { print(x); schedulerYield() }`,
  another pushes to `g` 100k times.
- **At `284606cc`:** printed `1, 4, 0` from a freed buffer. The for-in freeze on a mutable
  global was interprocedural (a callee that writes `g` is rejected) but not cross-task: the
  body parked, the other task reallocated the buffer, the loop variable resumed as a pointer
  into it.
- **Now:** `error: 'schedulerYield' can park this task while the loop variable is a reference
  into 'g's buffer; another task may push to 'g' before it resumes`, with the hint `iterate by
  index ('while i < g.len'), snapshot first ('g.clone()'), or move the global into a value the
  task owns`. `@parks` is the attribute; it sits on `swapcontext` and "may park" is derived
  transitively, so `await`, channel ops, `Select.wait` and `sleepMs` all carry it without
  listing. Slices and `&` into an element are views too (`globalSliceAcrossPark`); a `&mut` to
  the global's header is not (the header survives a realloc, the buffer does not).
  `tests/errors/globalForInAcrossYield.milo`, `globalForInParkTwoDeep`,
  `globalSliceAcrossPark`; `examples/` and `~/git/hades` still compile.
- **Commit:** `742bf8fd`. **Found by:** the 2026-09-19 battle test (H3).

### Finding #6 (closed): a `ptr()` outlived the realloc of its source

- **Shape:** `let p = v.ptr(); v.push(66); strlen(p)`, all in safe code: no `unsafe`, no
  thread, no generic. `s.cstr()` is the same hole spelled for strings.
- **At `284606cc`:** ASan heap-use-after-free. `ptr()` returned a `*T` with no provenance, the
  push reallocated, and a scalar-returning extern read the stale pointer. Requiring `unsafe`
  instead was rejected: 49 call sites in std and examples would each have gained a label that
  prevented nothing.
- **Now, round 1 (`c3d08e36`):** a pointer bound to a name is an element view of its source,
  exactly like a for-in binding. `error: 'v' may reallocate here while 'p' still points into
  its buffer (from 'v.ptr()' on line 11)`; hint `take the pointer after the last mutation, or
  pass 'v.ptr()' inline to the call`. Inline `f(v.ptr())` stays legal; a cast forwards
  provenance. `tests/errors/vecPtrOutlivesRealloc.milo`, `cstrOutlivesPush`.
- **Round 2 (`0503023d`, "pointer views join the one view list"):** round 1 tracked pointer
  holders in the freeze machinery and finding #5 tracked for-in and slice bindings in the global
  walk, two lists for one concept. `fuzz:tasks`'s first pass found the five programs that fell
  between them, all zero-`unsafe`, all ASan red: a callee that pushes to the global
  (`'writer' writes the global 'g' while 'p' still points into 'g's buffer`); an inline
  `growRead(v.ptr(), v)` against a `&mut v` argument (`'v' is borrowed mutably and shared in the
  same call`); a use after the source moved (`'p' used after its source 'v' was moved`, with
  `forget(v)` as the one sanctioned hand-off); a pointer pushed into a `Vec<*u8>` (the
  container is a holder); and `let p = g.ptr(); schedulerYield()` in a task (the park walk reads
  the same list). `tests/errors/ptrGlobalCalleePush.milo`, `ptrInlineAliasMutArg`,
  `ptrUsedAfterSourceMoved`, `ptrEscapesIntoVec`, `ptrGlobalAcrossPark`. Remaining gap,
  documented in [ownership-model.md](ownership-model.md) rather than checked: a user function
  that stashes its `*T` parameter in a global.
- **Found by:** independent review, 2026-09-19 (H4); round 2 by `fuzz:tasks`'s first pass.

### Finding #7 (closed): a `Drop` element copied out of a container anywhere but `let`

- **Shape:** `Option.Some(v[0])` or `peek(v[0])` with `v: Vec<Res>` and `Res: Drop`.
- **At `284606cc`:** made 1, gone 3. The rule "cannot take a Drop element out of a container
  by index" fired only at `let x = v[i]`; the same IndexAccess consumed by value as a call
  argument, enum payload, struct field, return or assignment was an implicit bitwise copy, and
  every copy ran `Drop`. A pure-checker hole, one judgment made at one site and not another.
- **Now:** `error: cannot take 'Res' out of a container by index: it carries Drop` at every
  by-value consumption site, with the hint naming the three legal spellings (`.clone()`, a
  borrow, or `swap`/`remove`). Borrow forms (`v[0].field`, `v[0].method()`, a `&Res` parameter)
  stay legal. Seven std sites were copying `Drop` elements (`Arena.get`, `arenaGet`,
  `frozenGet`, `FrozenArena.get`, `GrowOnlyArena.get`, `HashSet.toVec/clone`); they now clone
  explicitly and declare it with `@copyOut`. `tests/errors/dropElementAsCallArg.milo`,
  `dropElementIntoEnumPayload`, `dropElementInStructLit`, `dropElementReturned`,
  `dropElementAssigned`, `dropElementVecClone`, `copyOutArenaGet`.
- **Commit:** `67392368`. **Found by:** `fuzz:generic-drop`'s first pass (H5).

### Finding #8 (closed): a dropped channel leaked its undelivered payloads

- **Shape:** `Channel<Res>` with N values sent and fewer received when the last owner drops;
  `promiseRace` losers are the same shape.
- **At `284606cc`:** made N, gone 0. `impl Drop for ChannelHandle` freed `buf` without running
  `T`'s drop glue on the slots between head and tail. A leak, not UB, and the only finding in
  the runtime rather than the checker.
- **Now:** the drop runs `T`'s glue on every queued slot before `free(buf)`; a value already
  received belongs to the receiver and is counted once. `tests/fixtures/channelDropsUndelivered.milo`
  (`wraparound: made 4 gone 4`), `promiseRaceLosersDropped`; both on `tests/leak-clean.txt`.
- **Commit:** `c6412f83`. **Found by:** `fuzz:generic-drop`'s first pass (H6).

### Finding #9 (closed): an `impl` method's signature was never checked against the trait

- **Shape:** `impl Add for Res { fn add(self: Res, other: Res): Res }` when the trait declares
  `self: &Self, other: &Self`; then `v[0] + v[1]`.
- **At `284606cc`:** printed `8703489800`, gone 5. The operator passed operands by reference,
  the by-value body read garbage through them and ran extra drops. Found while writing the
  fixtures for finding #7: the first version of the test was itself this program.
- **Now:** `error: 'add' in 'impl Add for Res' takes 'self: Res' by value; the trait 'Add'
  declares 'self: &Self'`, hint `the trait's signature is 'fn add(self: &Self, other: &Self):
  Self'; write it that way in the impl`. Receiver mode, arity, each parameter's type and
  reference mode with `Self` substituted, and the return type are all checked, for user traits
  and the operator traits alike. `tests/errors/implMethodByValueVsTraitRef.milo`,
  `implReceiverModeMismatch`, `implMethodWrongArity`, `implMethodWrongReturnType`,
  `implGenericTraitSubstSelf`; `tests/fixtures/implSignatureMatches.milo`.
- **Commit:** `384c935c`. **Found by:** WP9, the finding #7 fix (H7).

### Finding #10 (closed): the prover reported a havoc as a counterexample

Not memory safety; listed because it is the row where the prover claimed more than it shipped.

- **Shape:** `fn push1(v: &mut Vec<i64>) ensures v.len == old(v.len) + 1 { v.push(1) }`; and
  a `requires v.len > 0` reached across any contract-less call.
- **At `284606cc`:** `push1`'s postcondition **failed** with counterexample `v_len__mut1 = 0`,
  a state no `Vec` can reach after a push; the second shape **failed** with `len = -1`. Builtin
  `Vec.push` had no contract, the walker havoced `v`, and the model over the unconstrained
  symbol was minted as a counterexample. That contradicts the roadmap's "unknown is reported as
  unknown".
- **Now:** builtin `Vec`/`string` methods carry a contract table (`BUILTIN_CONTRACTS` in
  `src/verify.ts`: `push`, `pop`, `clear`, index-assign, `len`), every `len` symbol carries
  `>= 0` from the moment it is minted, and a havoc with no contract behind it yields `unknown`.
  A deliberately wrong `ensures v.len == old(v.len) + 2` after one push still fails with a real
  counterexample, which is what separates a model from a havoc. A loop that mutates a place only
  through len-preserving operations keeps `len` across the havoc (`ec108569`).
  `tests/prove/builtinPushFrame.milo`, `havocNoContractUnknown`, `builtinContainerContracts`,
  `loopIndexAssignKeepsLen`.
- **Commits:** `ae1a86d0`, `ec108569`. **Found by:** the 2026-09-19 battle test (P1, P2).

## What the compiler does not check, and what happens instead

Milo's axiom is that **values are closed**: nothing aliases in, nothing escapes out.
References are second-class ([ownership-model](ownership-model.md)). That buys no lifetimes,
structural disjointness and cheap proofs. It also leaves three workloads where Rust's ability
to *keep* a reference safely is a real advantage Milo does not match. They are not bugs; they
are the price of the axiom, and every later design decision should stay honest about them.
Users will find these gaps themselves; naming them first is cheaper than being caught denying
them.

As of 2026-09-20 each of the three has had its most common workload taken out of it by the same
idea, with no new language rule: where Rust proves a property of a reference, Milo removes the
operation that could violate the property, and the move checker proves the removal.

| Gap | Rust proves | Milo removes | Mechanism |
|---|---|---|---|
| 1 staleness | a stored reference never goes stale | removal (`free`/`clear` do not exist) | `Arena.freeze` |
| 2 aliasing | disjoint `&mut` borrows | aliasing (ownership divides) | `parallelMap` and friends |
| 3 invalidation | a borrow outlives its referent | mutation (no mutating method exists) | `seal` + `Span`, branded `json` cursors |

Each subsection says what its mechanism closed and, at more length, what it did not. The gap
did not disappear; it split into a compile-time half and a smaller runtime-checked half, and
naming that second half is what these subsections are for.

### 1. Compile-time rejection of stale stored references

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
reuse keep their generational checks and stay exactly as described above. So the gap does not
close here, it splits: build-then-read is now compile-time, free-and-reuse is still runtime-checked
and still waiting on the contracts profile. Two checks also survive `freeze` and are not about
staleness at all, a handle from a different arena and an index past the end; both abort with a named
message rather than read unrelated memory.

For most code, runtime-deterministic is fine. For TLS session state, kernel objects, or a DB engine's page table — where a stale-handle panic in production is itself unacceptable — Rust's compile-time rejection is genuinely stronger. Milo's answer to that tier is the contracts profile (see [verification-roadmap](verification-roadmap.md)): prove `pool.contains(h)` statically and the runtime check is elided. Until a given call is proven, it runs checked. That is graceful degradation Rust's all-or-nothing signature can't offer — but the *default* is a runtime check, and honesty requires saying so.

### 2. In-place shared-memory parallelism

`par_iter_mut`, scoped threads carving one array into disjoint mutable slices, work-stealing over shared state — Rust checks these safe. Milo **bans the workload** rather than checking it. There is no `&mut [T]` split into aliasing-free sub-slices across threads (see backlog: mutable slice split). Multicore scaling is Node-style: processes, message passing, `Promise.blocking` workers that move-capture their inputs.

**Divisible ownership now covers the in-place case** (2026-08-22, `std/shard`). Rust proves that
several `&mut` slices into one buffer are disjoint. Milo does not prove it, because it makes the
ownership itself divisible: `parallelMap` CONSUMES a `Vec`, divides it into disjoint owned
windows, and each worker receives one by move like any other value. No reference crosses a
thread. The aliasing argument is the move checker that already shipped: a window holds a raw
pointer and is therefore move-tracked, so handing the same window to two workers is a compile
error rather than a race.

Measured on a 10-core machine, 20M `f64`, 4 workers, against the C program doing the banned thing
(pthreads over one shared buffer): Milo 3 ms / 163.0 MiB, C 3 ms / 154.0 MiB, Milo sequential
6 ms / 153.9 MiB. Times at this size are bandwidth-bound and move around in the 3-7 ms band run to
run; the memory figures are stable to a tenth of a MiB. The copy tax is gone; what remains is a flat 9.1 MiB of worker stacks, the same
fixed cost at 40M elements. Reproduce with `sh benchmarks/shard/run.sh`.

What closed on 2026-09-19 (finding #4), and what it cost: a window is a pointer into the owner's
buffer, and dropping the owner while a worker still held a window was a use-after-free nothing
caught. Until then the manual `shatter`/`windows`/`weld` path was offered with a "keep the owner
alive until weld" obligation and a runtime completeness check that could only notice a miss after
the fact. That path is now private to `std/shard`, so the obligation no longer exists for anyone
to meet. Every public form (`parallelMap`, `parallelMapWith`, `parallelScanStr`) creates every
window, hands out every window, awaits every worker and reassembles inside one call, so no caller
code exists in which the owner can die first: completeness follows from the shape of the call. It
is the same guarantee Rust's scoped threads get from lifetimes, reached by closing the cycle
inside one function rather than by proving a lifetime. The cost is expressiveness, not soundness:
the windows are never yours to hold apart, so a worker pool you drive yourself, stencils with
overlapping halos, true 2D tiles, and long-lived contended shared state all remain outside what
dividing ownership can do.

For a parser, CLI, or service this is the right trade and often faster to reason about. For a physics kernel, an ECS inner loop, or a tiled image filter that must share one buffer across cores, Rust does the thing Milo won't. Don't pretend the process model covers it — it covers throughput, not shared-memory data parallelism.

### 3. Stored zero-copy

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

### The claim discipline

Never say indices eliminate memory bugs. The correct claim, always:

> Pool indices and generational handles **demote memory-unsafety** (UB, corruption, exploitability) **to logic bugs** (wrong value, deterministic panic). SlotMap and newtyped keys then catch most of *those* too.

A wrong index is still a bug. It is a bug that crashes deterministically or returns the wrong value — not one that corrupts the heap or becomes a CVE. That demotion is the whole safety pitch. Overstating it to "no bugs" forfeits the credibility the honest version earns.

### Target and anti-target

**Target:** parsers, CLIs, services, leaf libraries — code where ownership is mostly a tree, references are mostly transient, and the pool/handle/message-passing style is what expert Rust converges on anyway. Milo makes that style primary and deletes the machinery that served the other style.

**Anti-target:** event-loop runtimes with GC-managed FFI, SMP monoliths and other shared-memory data-parallel workloads, systems that must store zero-copy borrows across a buffer's lifetime. Milo can be *used* there, against the grain, but it is not competing to win there.

Note "kernels" is *not* on this list. Freestanding/no-runtime is shipped, and a single-core RTOS core needs no shared-memory parallelism — interrupt masking is the lock. The anti-target is the *SMP* part, not the bare-metal part. See [kernel-feasibility](kernel-feasibility.md).

### The pitch, stated correctly

Not "Rust minus annotations." It is: **the pool / handle / message-passing style that expert Rust code converges on anyway, made primary, with the machinery that mostly served the other style deleted.** The three gaps above are what that machinery was for. We removed it on purpose, and we say what it cost.

## How to extend this battle-test

Add a runnable Rust↔Milo receipt to `rust-comparison/` or a focused fixture under `tests/errors`, `tests/runtime-errors`, or `tests/fixtures`. Each probe should trigger exactly one outcome, and the receipt runner must assert its classification and diagnostic text. A new checker rule also owes the fuzzer a shape: `scripts/fuzz-tasks.ts`'s generator for anything involving globals, tasks, threads or raw pointers, `scripts/fuzz-generic-drop.ts`'s seed table for a generic std symbol whose happy path cannot be derived from its signature. Remaining trust-boundary work includes adversarial FFI receipts, auditing each stdlib `unsafe impl Send` / `Sync` invariant, and explicit wrong-buffer span tests (a logic-integrity gap rather than memory UB).

## See also

- [ownership-model.md](ownership-model.md) — why no lifetimes; the Rust→Milo pattern table
- [ownership-patterns.md](ownership-patterns.md): the five patterns that make the dangerous thing unrepresentable
- [plans/soundness-sweep-2026-09.md](plans/soundness-sweep-2026-09.md): the sweep's work packages, gates and closing commits
- [verification-roadmap](verification-roadmap.md): the contracts profile that narrows gap 1
- [design.md](design.md) — §Overflow (shipped status), §Ethos (principle ordering)
