<!-- doc-meta
system: ownership-model
purpose: why Milo has no lifetimes — second-class references as guardrails, and how that compares to Rust
key-files: src/checker.ts, docs/language-reference.md, docs/design.md
update-when: reference semantics change (second-class rule, borrow/exclusivity checks, slices/arenas)
last-verified: 2026-07-13
-->

# Ownership & references — why there are no lifetimes

Milo is memory-safe with **no garbage collector, no reference counting in safe code, and no lifetime annotations**. This page explains how that works and why the design is shaped this way, especially if you're coming from Rust and wondering where `<'a>` went.

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

## Guardrails, not extra power

A tempting misreading is "Milo's borrow model is more powerful than Rust's." It isn't. For the common case — threading `&mut` down a call tree — **Rust needs no lifetime annotations either** (elision handles it). Side by side, the two languages look identical:

```milo
// Milo
fn render(doc: &mut Document, out: &mut Buffer): void { ... }
```
```rust
// Rust — same shape, no <'a> required
fn render(doc: &mut Document, out: &mut Buffer) { ... }
```

The difference is in what each language lets you build instead.

Suppose you want to **store** a reference. The classic case is a tree whose child nodes each keep a link back to their parent — a `parent` pointer, the kind you reach for in trees, UI layouts, and document models. Rust lets you store that reference, and it has a cost:

```rust
// Rust permits this — and the lifetime spreads
struct Node<'a> {
    parent: &'a Node<'a>,       // storing a reference adds a lifetime parameter...
    children: Vec<Node<'a>>,    // ...that every type touching Node must now carry
}
```

When the links form a cycle (parent → child → parent, both mutable), the borrow checker rejects the aliasing outright — so the usual way to keep that shape is interior mutability:

```rust
struct Node { parent: Option<Weak<RefCell<Node>>>, children: Vec<Rc<RefCell<Node>>> }
// node.borrow_mut()...  // safety check moved to RUNTIME — can panic; heap + refcount per node
```

The first *declaration* type-checks, but it's a trap: a mutable, parent-linked tree is essentially unbuildable with `&'a mut` — filling in a child's `parent` while the parent is itself borrowed to hand out the child is exactly the self-referential aliasing the borrow checker forbids, so in practice you can only build the immutable-node variant. The second one you *can* build, but it moves the safety check to runtime (`borrow_mut()` can panic) and adds a heap allocation plus refcount per node. And the `<'a>` from either spreads through every type that touches `Node`.

The design Rust programmers most often settle on for this is **neither** — it's to stop storing references and refer by *index* instead: put the nodes in one owner (a `Vec` or arena) and store a plain id for the parent link.

```rust
struct Node { parent: usize, children: Vec<usize> }   // ids, not references — no 'a, no Rc
struct Tree { nodes: Vec<Node> }
```

Rust *offers* all three; it doesn't insist on any one. Milo offers only the last: `struct Node { parent: &Node }` won't compile, and there is no `Rc<RefCell>` to reach for, so referring by index/handle (or passing `&mut` down a call tree) is the only path available.

This is about what the language **enforces** versus merely **permits**, not about programmer skill. Milo leaves out the options that carry a hidden cost, so the version you write is the one both languages consider clean. Milo removes the costly alternatives rather than doing something Rust can't.

## The cost, and how to pay it

Forbidding stored references gives something up: **borrowing structs** — a type that holds a view into memory it doesn't own. Rust's `<'a>` buys exactly this, e.g. a zero-copy parser:

```rust
struct Parser<'a> { input: &'a [u8], pos: usize }   // holds a borrow, copies nothing
```

Milo can't store the `&[u8]`. But **zero-copy does not require storing a pointer** — it requires storing an *offset*. The two idiomatic replacements need no lifetimes and copy nothing:

- **Spans.** Store `{ start, len }` integers into a buffer owned elsewhere. `std/json`'s parser does exactly this — string values are offsets into a resident `source`, materialized only on read. A million tokens is a million small structs, not a million string copies. (It's the same zero-copy shape `serde(borrow)` / `simd-json` use — they express it with a borrow lifetime, `'de`; Milo expresses it with an offset, so no lifetime is needed.)
- **Arenas + handles.** `std/arena` gives `Arena<T>` + a `Copy` generational `Handle<T>`. A tree or graph stores handles, not `&Node` — a lifetime-free AST. This is the design rustc and most production Rust compilers pick *on purpose*, precisely to escape `<'a>` propagation.

What you actually trade away is narrow: the compile-time *tie* between a view and its buffer (a span is just integers, so nothing stops you indexing it into the wrong buffer — still memory-safe via bounds checks, but a logic bug Rust's `&'a` would have caught), plus a featherweight generational check on arena access.

## When each model wins

- **Owns-its-data work** (emulators, interpreters, servers, most application code): Milo's model is a clean win — it deletes the ceremony *and* the footguns, with nothing lost.
- **Borrow-heavy zero-copy libraries** (a parser handing out `&str` slices into a source file): Rust's lifetimes earn their complexity; Milo expresses the same thing with spans/arenas at the cost of the view↔buffer compile-time tie.

Milo bets that the first case is far more common than the second. For systems code that owns what it touches, that bet pays off on every line.

## See also

- [language-reference.md](language-reference.md) — reference syntax, slices, arenas
- [design.md](design.md) — rationale for the second-class-reference choice
