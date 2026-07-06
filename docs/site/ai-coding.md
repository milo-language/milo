# AI-Assisted Development

Milo is designed so that **wrong code fails to compile, not fails silently at runtime**. When LLM-generated code has a bug, the compiler catches it with a clear error — there is no middle ground where code compiles, appears to work, and hides a latent memory-safety bug.

## The precision floor

Every language has a **precision floor** — the minimum level of detail a programmer must get right for correct code.

- **Python / TypeScript:** Low floor. LLMs operate comfortably above it. But no memory safety — not suitable for systems work.
- **C++:** Highest floor of any mainstream language — move semantics, implicit conversions, undefined behavior, template instantiation, header order, simultaneously. LLMs operate **below** this floor.
- **Rust:** High floor, differently. The borrow checker rejects correct-in-spirit code that violates lifetime rules. LLMs spend iterations fighting the compiler instead of shipping features.
- **Milo:** Low floor for a systems language. Get the types and ownership right and the compiler handles the rest. No implicit conversions, no UB, no lifetime annotations, no header files.

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
4. **Null deref** — LLMs forget null checks; C++ can't enforce them. Milo: `Option<T>` with exhaustive match (or explicit `w!`).
5. **Data races** — LLMs share mutable state across threads freely. Milo rejects non-Send captures at compile time.
6. **Integer overflow** — signed overflow is UB; compilers delete "impossible" checks. Milo: compile-time checks for constants, debug traps, explicit `wrappingAdd`/`saturatingAdd`.

The pattern, concretely:

```cpp
// C++ — compiles, UB
std::vector<int> v = {1, 2, 3};
auto v2 = std::move(v);
v.push_back(4);          // "valid but unspecified" — may silently corrupt
```

```milo
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

```milo
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
// Milo — compile error
var counter = 0
Thread.spawn(() => { counter += 1 })  // ERROR: `counter` is not Send

// correct version:
let counter = AtomicI64.new(0)
Thread.spawn(move () => { counter.add(1) })  // OK — AtomicI64 is Send
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

**The tradeoff:** C++ lets wrong code compile silently (UB). Rust rejects correct-in-spirit code. Both are bad for LLMs, for opposite reasons. Milo threads the needle: strict enough to catch real bugs, simple enough that correct-in-spirit code actually compiles.

## Summary

| Property | C++ | Rust | Milo | Impact on LLM code |
|---|---|---|---|---|
| Implicit conversions | ~15 built-in | Zero | Zero | LLMs can't introduce silent type bugs |
| Undefined behavior | 200+ categories | None in safe code | None in safe code | Wrong code crashes loud, not silent |
| Null | Raw pointers | `Option<T>` | `Option<T>` | Compiler forces null handling |
| Memory safety | Manual | Borrow checker + lifetimes | Moves + second-class refs | Use-after-free = compile error (both) |
| Lifetime annotations | N/A | Required, complex | None, ever | No borrow checker fights |
| Thread safety | Nothing enforced | Send/Sync | Send/Sync | Data races can't compile (both) |
| Error handling | Exceptions (invisible) | `Result<T,E>` + `?` | `Result<T,E>` + `?` | Error paths can't be ignored (both) |
| Build complexity | Headers, includes, ODR | Cargo (good) | Single files, simple imports | Less surface area for confusion |
| Precision floor | Very high | High (lifetimes) | Low (for a systems lang) | Fewer LLM↔compiler iteration loops |
