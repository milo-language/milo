<!-- doc-meta
system: ownership-model
purpose: why Milo has no lifetimes — second-class references as guardrails, and how that compares to Rust
key-files: src/checker.ts, docs/language-reference.md, docs/design.md
update-when: reference semantics change (second-class rule, borrow/exclusivity checks, slices/arenas)
last-verified: 2026-07-13
-->

# Ownership & references — why there are no lifetimes

Milo is memory-safe with **no garbage collector, no reference counting in safe code, and no lifetime annotations**. This page explains how that works and, more usefully, *why the design is shaped this way* — especially if you're coming from Rust and wondering where `<'a>` went.

## The one rule: references are second-class

A reference (`&T` / `&mut T`) may appear **only as a function parameter**. It can never be:

- stored in a struct field,
- returned from a function,
- bound and kept past the call it was created for.

```milo
fn step(cpu: &mut Cpu, bus: &mut Bus): void { ... }   // fine — params
struct Holder { r: &i64 }                              // error: refs can't be stored
fn danger(): &i64 { ... }                              // error: refs can't be returned
```

That single restriction is why Milo needs no lifetimes. Lifetimes exist, in languages that have them, to *track references that escape* — references returned from functions or stored in structs, whose validity must be proven to outlive their referent. Milo forbids escape outright, so there is nothing to annotate. The borrow checker still runs **inside** each function (it rejects mutating a collection while a loop or slice borrows it, and rejects aliasing a `&mut` and `&` into the same place at a call). "No lifetimes" does **not** mean "no borrow checking" — it means the checking never needs a syntax.

## The part worth understanding: guardrails, not magic

A tempting misreading is "Milo's borrow model is more powerful than Rust's." It isn't. For the common case — threading `&mut` down a call tree — **Rust needs no lifetime annotations either** (elision handles it). Side by side, the two languages look identical:

```milo
// Milo
fn step(cpu: &mut Cpu, bus: &mut Bus): void { ... }
```
```rust
// Rust — same shape, no <'a> required
fn step(cpu: &mut Cpu, bus: &mut Bus) { ... }
```

The difference is not what the clean code looks like. It's what the language *lets you do instead*.

Consider a mutable object graph — say an emulator where the CPU drives the PPU through a bus, and the PPU raises an interrupt back at the CPU. The **beginner's instinct** is to store a back-reference:

```rust
// Rust — lets you try this, and it costs you
struct Cpu<'a> {
    bus: &'a mut Bus,   // storing a ref infects Cpu with a lifetime...
}
struct System<'a> { cpu: Cpu<'a> }   // ...which propagates outward like a virus
```

and when the graph is genuinely cyclic (CPU ↔ PPU both mutable), the borrow checker rejects it outright, so the undisciplined escape hatch is **interior mutability**:

```rust
struct Cpu { bus: Rc<RefCell<Bus>> }   // heap alloc + refcount + runtime borrow flags
// self.bus.borrow_mut()...            // moves the borrow check to RUNTIME — can PANIC
```

Both of these *compile* in Rust. Both are worse: the first spreads `<'a>` through every type that touches `Cpu`; the second trades compile-time safety for runtime `borrow_mut()` panics and per-node heap overhead. The clean Rust design also exists —

```rust
struct System { cpu: Cpu, bus: Bus }        // own everything in one place
fn step(cpu: &mut Cpu, bus: &mut Bus) { }   // pass &mut down — no 'a, no Rc
```

— but Rust only *offers* it; it doesn't *insist* on it. A disciplined Rust programmer converges here. An undisciplined one reaches for `Rc<RefCell>` and ships the spaghetti.

**Milo makes the clean design the only representable one.** `struct Cpu { bus: &Bus }` won't compile, and there is no `Rc<RefCell>` to fall back to, so the only path is "own the data in one place and pass `&mut` down." Milo isn't doing something Rust can't. It's **removing the wrong options** so that a beginner writes expert-shaped code by default. Guardrails, not magic.

## The honest cost — and how to pay it

Forbidding stored references gives something up: **borrowing structs** — a type that holds a view into memory it doesn't own. Rust's `<'a>` buys exactly this, e.g. a zero-copy parser:

```rust
struct Parser<'a> { input: &'a [u8], pos: usize }   // holds a borrow, copies nothing
```

Milo can't store the `&[u8]`. But **zero-copy does not require storing a pointer** — it requires storing an *offset*. The two idiomatic replacements need no lifetimes and copy nothing:

- **Spans.** Store `{ start, len }` integers into a buffer owned elsewhere. `std/json`'s parser does exactly this — string values are offsets into a resident `source`, materialized only on read. A million tokens is a million small structs, not a million string copies. (This is what `serde(borrow)` / `simd-json` do too — minus the lifetime.)
- **Arenas + handles.** `std/arena` gives `Arena<T>` + a `Copy` generational `Handle<T>`. A tree or graph stores handles, not `&Node` — a lifetime-free AST. This is the design rustc and most production Rust compilers pick *on purpose*, precisely to escape `<'a>` propagation.

What you actually trade away is narrow: the compile-time *tie* between a view and its buffer (a span is just integers, so nothing stops you indexing it into the wrong buffer — still memory-safe via bounds checks, but a logic bug Rust's `&'a` would have caught), plus a featherweight generational check on arena access.

## When each model wins

- **Owns-its-data work** (emulators, interpreters, servers, most application code): Milo's model is a clean win — it deletes the ceremony *and* the footguns, with nothing lost.
- **Borrow-heavy zero-copy libraries** (a parser handing out `&str` slices into a source file): Rust's lifetimes earn their complexity; Milo expresses the same thing with spans/arenas at the cost of the view↔buffer compile-time tie.

Milo bets that the first case is far more common than the second. For systems code that owns what it touches, that bet pays off on every line.

## See also

- [language-reference.md](language-reference.md) — reference syntax, slices, arenas
- [design.md](design.md) — rationale for the second-class-reference choice
