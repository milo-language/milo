<!-- doc-meta
system: ai-coding
purpose: how Milo's guarantees map onto the failure modes of machine-generated code
key-files: docs/site/language/safety.md, docs/language-reference.md
update-when: a safety guarantee changes, or the list of covered failure modes moves
last-verified: 2026-08-23
-->

# AI-Assisted Development

Milo is designed so that **wrong code fails to compile, not fails silently at runtime**. When LLM-generated code has a bug, the compiler catches it with a clear error — there is no middle ground where code compiles, appears to work, and hides a latent memory-safety bug.

## The precision floor

Every language has a **precision floor** — the minimum level of detail a programmer must get right for correct code.

- **Python / TypeScript:** Low floor. LLMs operate comfortably above it. But no memory safety — not suitable for systems work.
- **C++:** Highest floor of any mainstream language — move semantics, implicit conversions, undefined behavior, template instantiation, header order, simultaneously. LLMs operate **below** this floor.
- **Rust:** High floor, differently. The borrow checker rejects correct-in-spirit code that violates lifetime rules. LLMs spend iterations fighting the compiler instead of shipping features.
- **Milo:** Low floor for a systems language. Get the types and ownership right and the compiler handles the rest. No implicit conversions, no UB, no lifetime annotations, no header files.

## Local reasoning

The precision floor is about how often a model gets rejected. The more useful
property is how much of a program it has to hold in mind to be *right*.

Because references are second-class — never stored, never returned except as a view
of a receiver's own data — nothing in the heap is aliased. That has a direct
consequence for reading code: **the state a function can touch is its parameter
list.** There is no other pointer into that data, so a mutation here cannot change
something over there. Verifying a function means reading that function.

This is the failure mode that makes C++ and Rust-with-`Rc<RefCell>` expensive for a
model to write correctly: not that the syntax is hard, but that correctness depends
on facts established somewhere else in the program. Whole classes of bug — a
callback mutating a container someone else is iterating, a `&mut` handed out twice,
a struct outliving the buffer it points into — are questions about global state.
Milo makes them unwritable rather than answerable.

The same locality shows up in the error messages. A borrow-checker error often
requires a global fix: restructure ownership three call frames up. Milo's aliasing
errors are call-site-local, because the rule they enforce is call-site-local:

```
error: 'v[0..2]' and 'v[1..3]' overlap and are both borrowed mutably
  hint: the ranges share element 1 — use disjoint ranges, or split the call
        into two statements
```

### What a signature does not tell you

Aliasing is only half of it. A signature says what a function may mutate; it does
not say whether the function printed, read a file, opened a socket, or touched
module state. `@pure` closes that for the functions that opt in:

```milo error
from "std/math" import { Math }

@pure
fn hypot(a: f64, b: f64): f64 {
    return Math.sqrt(a * a + b * b)     // the whole Math namespace is @pure
}

@pure
fn logged(x: i64): i64 {
    print(x)                            // error: 'logged' is @pure but calls
    return x                            //        'print', which is not
}
```

A `@pure` function reads and writes only its parameters and its own locals: no I/O,
no module state, no raw memory, and no calls that could reach any of those. It can
still trap — purity is not totality.

For generated code that changes what a reviewer has to do. A `@pure` signature whose
parameters are all by-value or `&T` is a compiler-checked claim that the call is safe
to skip, reorder, cache, or retry, so scrutiny concentrates on the effectful code. And
a model that writes I/O where the type says it cannot gets a compile error instead of a
silent behavioral difference.

The honest caveat: verbose, machine-checkable signatures were always a hard sell to
humans, and the traditional objection to effect tracking is that it is boilerplate.
That objection weakens when the code is mostly written by a model and mostly read by a
person auditing it — writing it is nearly free, checking it is not. But the
training-data problem cuts the other way: a design that is easier to *verify* is not
automatically easier to *generate*. See
[Effects and capabilities](https://github.com/milo-language/milo/blob/main/docs/effects-and-capabilities.md)
for what is shipped and what is only proposed.

## Built-in LLM support

```bash
milo skill    # prints a complete language guide optimized for LLM context windows
```

Pipe it into any AI tool as system context — syntax, standard library, common patterns, and key rules in one command.

## vs. C++: silent bugs

C++ lets wrong code compile. LLMs generate plausible C++ that works in testing and fails in production. The six most common failure modes:

1. **Implicit conversions** — `char`/`int` blurring, `bool` arithmetic, unsigned wraparound in comparisons. Milo has zero implicit coercions; all are compile errors.
2. **Use-after-move** — moved-from C++ objects are "valid but unspecified"; LLMs don't track invalidation. Milo: compile error.
3. **Dangling references** — the most common C++ CVE pattern; LLMs routinely return refs to locals. Milo: impossible by construction.
4. **Null deref** — LLMs forget null checks; C++ can't enforce them. Milo: `Option<T>` with exhaustive match (or explicit `!`).
5. **Data races** — LLMs share mutable state across threads freely. Milo rejects non-Send captures at compile time.
6. **Integer overflow** — signed overflow is UB; compilers delete "impossible" checks. Milo: compile-time checks for constants, runtime traps in every build mode (release included), explicit `wrappingAdd`/`saturatingAdd`.

The pattern, concretely:

```cpp
// C++ — compiles, UB
std::vector<int> v = {1, 2, 3};
auto v2 = std::move(v);
v.push_back(4);          // "valid but unspecified" — may silently corrupt
```

```milo error
// Milo — compile error
var v = Vec.new()
let v2 = v               // v moved to v2
v.push(4)                // ERROR: use of moved value `v`
```

```cpp
// C++ — compiles with no warnings, caller reads freed memory
std::string_view getName() {
    std::string s = "hello";
    return s;
}
```

```milo error
// Milo — impossible by construction
fn getName(): &string {  // ERROR: cannot return a reference
    let s = "hello"
    return s
}
```

```cpp
// C++ — compiles, data race (UB per the standard)
int counter = 0;
std::thread t1([&]{ counter++; });
std::thread t2([&]{ counter++; });
```

```milo
from "std/runtime" import { Promise }
from "std/sync" import { AtomicI64 }

// Milo — a plain captured var is a copy; a raw pointer to it isn't Send, so
// there's no way to share unsynchronized mutable state across a blocking worker.
// correct version — share via an atomic:
let counter = AtomicI64.new(0)
let p = Promise<i64>.blocking(move (): i64 => {
    counter.add(1)    // OK — AtomicI64 is Send + Sync
    return 0
})
p.await()!
```

## vs. Rust: borrow checker fights

Rust catches more errors than Milo — full borrow checker, lifetime tracking. But LLMs can't reliably satisfy those constraints, leading to iteration loops where the LLM fights the compiler instead of writing features.

**Lifetime annotations confuse LLMs.** They write reasonable code that won't compile:

```rust
// Rust — won't compile
struct Parser {
    source: &str,  // needs Parser<'a> { source: &'a str }
}

fn parse(input: &str) -> Vec<&str> {  // needs lifetime annotations
    // ...
}
```

LLMs forget annotations, add them wrong, or over-annotate with `'static` (forcing `.clone()` everywhere). "LLM writes code → compiler rejects → LLM tries to fix lifetimes → makes it worse" is a well-documented failure mode.

```milo
// Milo — no lifetimes, ever
fn parse(input: &string): Vec<string> {
    // references are param-only, returned data must be owned
    return input.split(",")
}
```

**Trait bounds cascade.** Generic Rust hits chains of errors: `T: Clone`, then `T: Debug` for error messages, then `T: Send` for threading — each fix reveals the next missing bound. Milo's monomorphization resolves generics at compile time without bound cascading; if `T` lacks `.clone()`, the error points at the specific instantiation site.

**Ownership puzzles.** Correct-but-restrictive rules require non-obvious restructuring:

```rust
// Rust — can't mutate while iterating
let mut v = vec![1, 2, 3];
for x in &v {
    if *x > 2 { v.push(*x); }  // ERROR
}
```

An LLM "fixes" this with `.clone()`, `RefCell`, or `unsafe` instead of restructuring. Milo's simpler model — move or clone, no shared mutable borrows — produces fewer of these puzzles.

**The tradeoff:** C++ lets wrong code compile silently (UB). Rust rejects correct-in-spirit code. Both are bad for LLMs, for opposite reasons. Milo sits in between: strict enough to catch real bugs, simple enough that correct-in-spirit code actually compiles.

For the full threat-by-threat breakdown — what Milo catches at compile time vs runtime, where each language wins, and the arena/`Heap` patterns that replace lifetimes — see [Memory Safety vs Rust](/language/vs-rust).

## Summary

| Property | C++ | Rust | Milo | Impact on LLM code |
|---|---|---|---|---|
| Implicit conversions | ~15 built-in | Zero | Zero | LLMs can't introduce silent type bugs |
| Undefined behavior | 200+ categories | None in safe code | None in safe code | Wrong code crashes loud, not silent |
| Null | Raw pointers | `Option<T>` | `Option<T>` | Compiler forces null handling |
| Memory safety | Manual | Borrow checker + lifetimes | Moves + second-class refs | Owned UAF = compile error; cyclic = runtime-caught |
| Lifetime annotations | N/A | Required, complex | None, ever | No borrow checker fights |
| Thread safety | Nothing enforced | Send/Sync bounds | Structural Send, checked only where an OS thread starts | Data races can't compile (both) |
| Error handling | Exceptions (invisible) | `Result<T,E>` + `?` | `Result<T,E>` + `?` | Error paths can't be ignored (both) |
| Effects visible in the signature | Nothing | `&mut` and `unsafe` | `&mut`, `unsafe`, and `@pure` | A `@pure` call needs no review |
| Build complexity | Headers, includes, ODR | Cargo (good) | Single files, simple imports | Less surface area for confusion |
| Precision floor | Very high | High (lifetimes) | Low (for a systems lang) | Fewer LLM↔compiler iteration loops |
