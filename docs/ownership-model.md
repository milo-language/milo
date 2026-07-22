<!-- doc-meta
system: ownership-model
purpose: why Milo has no lifetimes — second-class references as guardrails, and how that compares to Rust
key-files: src/checker.ts, docs/language-reference.md, docs/design.md
update-when: reference semantics change (second-class rule, borrow/exclusivity checks, slices/arenas)
last-verified: 2026-07-22
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

## Long-lived state shared across tasks

A green task's body cannot borrow from the frame that spawned it: a `&Prog` or `&mut Interp` living in a caller's stack frame is exactly the stored reference the one rule forbids. So state that both **outlives the call that created it** and is **reached from more than one task** cannot travel by reference. Two sanctioned shapes — neither a workaround to feel bad about:

- **A module-level arena + handles.** Put the shared pool in a `var` at module scope (`var gNodes: Arena<Node>`) and pass `Handle<Node>` around — copyable, storable in fields, safe to hand to any task. A genuine one-of (a single interpreter, a loaded config) can be a plain global singleton instead. This is the same move milojs's `gInterp`/`gProg` make, and it is **endorsed, not shameful**: Milo has no way to say "this reference outlives the frame," so long-lived cross-task state lives at the one scope that outlives every frame — module scope. The cost is real and worth naming — one process holds one such pool, so it is not re-entrant, and there are now two ways to reach the same object (by handle and by the `&T` parameter functions still take) — but that is the correct shape for the constraint, not a failure to find a better one. When re-entrancy matters, promote the singleton to a registry: `var gEngines: Arena<Engine>` handed out per program, so one process can hold many.
- **No shared state at all — actors over channels.** Give each task its own state and have tasks communicate by sending values over a `std/sync` `Channel`, CSP-style. Nothing is shared, so nothing needs a shared reference. Prefer this when the units are naturally independent; reach for the global arena when they genuinely operate on one graph.

A specialized garbage-collected heap is the exception that proves the rule: milojs backs its JS objects with a hand-rolled `Vec<JSObj>` + integer handles rather than `std/arena`, because a mark-sweep collector already iterates every slot and already guarantees no handle outlives its object — the arena's per-slot generation check would be pure overhead. Hand-roll the heap when you *are* the memory manager; use `std/arena` everywhere else.

## Rust → Milo: the lifetime cases, side by side

The patterns that make Rust reach for `<'a>`, `Box`, `Rc<RefCell>`, or `unsafe`, and what you write instead. The last row is the direct expressivity gap in Milo's reference model; the alternatives above still carry different API, allocation, and runtime-check tradeoffs.

| Problem | Rust | Milo | Runnable |
|---|---|---|---|
| Zero-copy view (within a scope) | `let w: &str = &s[6..11];` | `let w = s[6..11]` — non-owning `&string`, no alloc | — |
| Recursive data (tree / AST) | `enum Expr { Bin(Box<Expr>, Box<Expr>) }` | `enum Expr { Bin(Heap<Expr>, Heap<Expr>) }`; deref sub-nodes with `*l` | reference §Heap |
| Recursive struct field | `struct Node { next: Option<Box<Node>> }` | `struct Node { next: Option<Heap<Node>> }` | — |
| Doubly-linked list | `Rc<RefCell<Node>>` or `unsafe` | arena + `Option<Handle<Node>>` (Copy handles, stored freely) | [linkedList.milo](../examples/linkedList.milo) |
| Cyclic graph / cross-refs | `petgraph`, arena+indices, or `Rc` | `Arena<GNode>` + `Vec<Handle<GNode>>` for edges | [depgraph.milo](../examples/depgraph.milo) |
| Tree with parent pointers (DOM) | `Rc<RefCell>` / arena crate | `Arena<Node>` + parent/children as `Handle` | [domArena.milo](../examples/domArena.milo) |
| Borrow-holding iterator / cursor | `struct Cur<'a> { buf: &'a [u8] }` | own the buffer + an integer `pos`; slice on demand | — |
| Long-lived cross-task state | `Arc<Mutex<T>>` / `&'static` | module-scope `var pool: Arena<T>`, pass `Handle` | (milojs `gInterp`) |
| **Type that STORES a borrow** (`Parser<'a> { src: &'a str }`) | `struct Parser<'a> { src: &'a str }` | **no direct equivalent** — own the `string` (clone once) or hold an index into a buffer you own | *the real gap* |

The directly unrepresentable row is the last: a struct field that is a *borrow* of data owned elsewhere. Milo's answer is to own the data or refer to it by index — memory-safe via bounds checks, at the cost of the compile-time view↔buffer tie Rust's `&'a` gives you. Production Rust also often chooses arenas to avoid lifetime propagation, but Rust retains other valid designs (`Rc`, borrowing APIs, and ecosystem arena crates) that Milo deliberately omits.

## When each model wins

- **Owns-its-data work** (emulators, interpreters, servers, most application code): Milo often removes lifetime ceremony, at the cost of a smaller set of representable APIs and occasional runtime identity/generation checks.
- **Borrow-heavy zero-copy libraries** (a parser handing out `&str` slices into a source file): Rust's lifetimes earn their complexity; Milo expresses the same thing with spans/arenas at the cost of the view↔buffer compile-time tie.

Milo bets that the first case is far more common than the second. For systems code that owns what it touches, that bet pays off on every line.

## See also

- [language-reference.md](language-reference.md) — reference syntax, slices, arenas
- [design.md](design.md) — rationale for the second-class-reference choice
- [memory-safety-vs-rust.md](memory-safety-vs-rust.md) — retained adversarial probes, compile vs runtime vs Rust
