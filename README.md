# Milo

**A memory-safe systems language with second-class references: no lifetimes, no GC, one owner per value.**

**Learn more at [milo-language.github.io/milo](https://milo-language.github.io/milo/)** — docs, language tour, playground, and demos you can play in the browser.

**The one rule.** `&T` and `&mut T` exist only as parameter types. A reference cannot be returned, stored in a struct or enum, or captured by a closure that outlives the call. Everything below follows from that.

**What you get**

- **No lifetime annotations.** A borrow's extent is the call, so there is nothing to name and nothing to propagate through the types that would hold it.
- **Local reasoning.** The function you are reading is the whole story of the values it touches: a `&mut x` at a call site is the full blast radius of a mutation, and every other effect is declared where it happens (`@unsafe`, `@thread`, `@parks`, `@mustUse`).
- **Single ownership, answered locally.** Every value has one owner and a borrow ends at the call, so the checker's questions are settled inside one function, never by a signature three modules away.
- **Concurrency without `Send`/`Sync`.** A value that cannot hold a borrow can be handed to another task as is. The compiler checks the two doors OS threads start at and rejects a view into a global held across a park.
- **No GC, no reference counting, ordinary imperative code.** `var`, `for` and in-place mutation through `&mut` are the idiom; it gets functional programming's "nothing else can change this" by scoping mutation, not banning it. Compiles through LLVM to a static binary.
- **Contracts and a prover.** `requires`/`ensures` are part of the language, and `milo prove` checks them for every input, not just the ones you tested.

**What you lose**

- **Returning a view.** `fn longest(a: &str, b: &str): &str` cannot be written. Return an index or a `Span`, an owned copy, or move the work to the caller.
- **Storing a view.** `Parser<'a>`, an iterator over a borrowed slice, `struct Node { next: &Node }`: own the buffer and carry offsets, or use [`std/arena`](docs/site/stdlib/arena.md) (generational handles, checked at runtime). Across five Rust codebases, 13% of lifetime-carrying declarations are this shape ([the census](docs/site/language/why-no-lifetimes.md)).
- **One compile-time check.** The tie between a stored offset and its buffer is a named runtime failure in Milo where Rust's invariant lifetime is a compile error. Nothing degrades to `unsafe`.
- **Some zero-copy.** Where Rust would hand out a borrow, Milo sometimes asks for a `clone()`. Verbose on purpose: a copy where you are already looking is cheaper than state you cannot see.

**Measured, not claimed.** We have written over 250k lines of Milo across the compiler (self-hosted), a JS engine, three emulator cores, a debugger and a dozen packages. Nearly every `unsafe` block in them is the C boundary, and not one exists because the ownership model rejected a program (see [memory safety vs Rust](docs/memory-safety-vs-rust.md)).
