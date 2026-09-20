<!-- doc-meta
system: ownership-patterns
purpose: the catalogue of data-structure patterns that buy safety properties without lifetimes, and the test that picks between them
key-files: std/arena.milo, std/seal.milo, std/shard.milo, docs/memory-safety-vs-rust.md, src/checker.ts
update-when: a new pattern is found, a pattern gains or loses a compiler diagnostic, or a seam moves between the closed and open lists
last-verified: 2026-09-20 (WP7: the claim-discipline link now points at memory-safety-vs-rust; patterns 3 and 5 verified against WP3/WP2/WP4 as shipped)
-->

# Ownership patterns

Milo has no lifetimes, so it cannot prove a property *about* a reference the way Rust
does. What it can do is arrange for the dangerous thing to be unrepresentable, and let
the move checker — which already shipped — do the proving.

This document is the catalogue of how, the test for choosing between them, and which
of them the compiler will point you at.

Everything here was derived by building `std/arena`'s `freeze`, `std/seal` and
`std/shard` and then asking what they had in common. None of the five patterns needed
a new checker rule.

## The test

Two questions decide which pattern applies. For the value that carries the risk:

1. **Does it escape?** Does it outlive the call that made it — stored in a struct,
   returned, pushed into a collection?
2. **Does it keep the dangerous operation?** Can something still free it, mutate it,
   realloc it, or hand it to a second owner?

The answers pick the pattern, and they are exhaustive:

| escapes | keeps the op | what to do |
|---|---|---|
| no | yes | **bound it to a call frame** |
| yes | no | **remove the operation** |
| yes | yes | **brand it** and demote the failure |

The third row is the honest one. When a value both escapes and needs the operation, no
data structure closes the hole; the best available is to make a wrong answer into a
named failure. That is the claim discipline of
[memory-safety-vs-rust](memory-safety-vs-rust.md) (§What the compiler does not check)
applied to this repo's own designs.

## The patterns

### 1. Remove the operation

Consume the value into a type on which the dangerous operation does not exist. The
result may escape freely, because there is no longer anything to go wrong.

- `Arena.freeze()` -> `FrozenArena<T>`: no `free`, no `clear`. Every handle stays
  valid, so `get` returns `T` rather than `Option<T>`.
- `seal(buf)` -> `Sealed`: no mutating method. Offsets into it cannot be invalidated
  because nothing can invalidate them.

The cost is real: you give the operation up permanently. Which is why the next pattern
exists.

### 2. Tier the restriction

Removing an operation is cheap only if you were not using it. When the jump is too
big, take one operation away at a time and let the program stop where it needs to:

| tier | `alloc` | `free` | `get` |
|---|---|---|---|
| `Arena<T>` | yes | yes | `Option<T>`, generation-checked |
| `GrowOnlyArena<T>` | yes | no | `T`, infallible |
| `FrozenArena<T>` | no | no | `T`, infallible |

`GrowOnlyArena` is the interesting rung: removing only `free` is already enough for an
infallible `get`, because no slot is ever recycled and so no handle can come to name a
different value. A symbol table that is still growing gets the guarantee without
ending its build phase.

Tiering is what keeps this catalogue from becoming a zoo. Each rung gives up exactly
one more operation and buys exactly one more guarantee.

### 3. Bound it to a call frame

If the value must keep the dangerous operation, stop it escaping instead: create it,
use it and destroy it inside one call, so no caller code exists in between.

`parallelMap(v, workers, f)` makes every window, hands out every window, awaits them
and welds them itself. The windows are raw pointers into a buffer, and dropping the
owner while one is live would be a use-after-free — but there is nowhere to write that
mistake. The pieces of the cycle (`shatter`, `windows`, `weld`) are private to
`std/shard` for exactly that reason: offered separately they were the mistake
(soundness sweep H2), and the after-the-fact completeness check inside `weld` is now an
internal assertion rather than a contract a caller can miss.

This is the same guarantee Rust's scoped threads get from lifetimes, reached by
closing the cycle instead of proving a lifetime. Its limit is that scoped means
lexical: an iterator, a state machine or anything the caller drives step-by-step
cannot be wrapped in a call you own.

### 4. Brand the identity

When the value both escapes and keeps its operation, tie it to the thing it belongs to
with a runtime tag, so using it against the wrong one fails by name instead of
returning something plausible.

- `Span` carries the identity of the `Sealed` it was measured from. Resolving one
  against a different buffer used to read wrong-but-in-bounds bytes and report
  nothing; it now aborts with a message naming the cause.
- `Handle<T>` carries its arena's id, and a `Shard` carries its shatter's.

Two rules make a brand worth having. It must be **free**: `Span` narrowed `len` to i32
to make room, so it is still 16 bytes and the benchmark did not move. And it must
**fail closed**: brands start at 1, so a hand-built value carrying 0 matches nothing.

A brand does not reach what Rust reaches. Rust rejects the wrong-buffer program at
compile time with an invariant lifetime. A brand converts a wrong answer into a named
failure, which is strictly less, and saying so plainly is the point.

### 5. Move tracking as the single-owner enforcer

A struct of plain scalars is `Copy`, and a `Copy` handle can be duplicated — which
means the move checker never engages for exactly the type most likely to be used after
it is released. Two rules turn the ordinary move rule into the enforcement mechanism: a
struct with a raw pointer field is move-tracked unless it says `@copy` (the claim that
it does not own the pointee), and `@noCopy` does the same for a handle that is only an
integer (an fd, a GL name).

`Shard<T>` is a pointer and three integers. The pointer makes it move-tracked, so
handing the same window to two workers is `error: use of moved variable`: a data race
rejected at compile time with no concurrency analysis, by the same rule that stops you
using a string twice.

`@copyOnly` closes the other half: `get` reads an element through the raw pointer, a
bitwise copy that is a second owner for any heap-owning `T`, so `Shard<string>` is
refused at the instantiation rather than freeing one block twice at runtime. Together
they say "this handle moves, and what it hands out copies", which is the whole
ownership story of a window.

## What the compiler tells you

Patterns nobody is pointed at get rediscovered, so where a better form exists the
compiler names it:

| diagnostic | says |
|---|---|
| `arena-never-frees` (warning) | this arena never frees; `sealGrowth()` is pattern 2 |
| `use of moved variable` (error) | patterns 1, 3 and 5 all land here — the move checker doing the work |
| missing field `brand` (error) | build spans with `spanOf`, not by hand (pattern 4) |

These reach the editor as well as the terminal: warnings carry a `code` in
`milo check --json`, which is what `src/lsp.ts` publishes.

## Open seams

The catalogue is not complete, and the gaps are the third row of the test — values that
escape *and* keep their operation, where only a brand is available:

- a rope or incremental parser holding views into a buffer it must keep mutating;
- an arena that genuinely frees and reuses, which keeps its generation check;

If you find a pattern that closes one of these without lifetimes, it belongs here.
