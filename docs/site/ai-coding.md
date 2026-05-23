# AI-Assisted Development

Milo is designed so that **wrong code fails to compile, not fails silently at runtime**. This makes it uniquely suited for AI-assisted development — LLM-generated code either compiles and is correct, or fails with a clear error message. There is no middle ground where code compiles, appears to work, and has a latent memory safety bug.

## The precision floor

Every language has a **precision floor** — the minimum level of detail a programmer must get right for correct code.

- **Python / TypeScript:** Low floor. LLMs operate comfortably above it. But no memory safety — not suitable for systems work.
- **C++:** Highest floor of any mainstream language. You must reason about move semantics, implicit conversions, undefined behavior, template instantiation, header inclusion order — simultaneously. LLMs operate **below** this floor.
- **Rust:** High floor, differently. The borrow checker rejects correct-in-spirit code that violates lifetime rules. LLMs spend iterations fighting the compiler rather than shipping features.
- **Milo:** Low floor for a systems language. If you get the types and ownership right, the compiler handles the rest. No implicit conversions, no UB, no lifetime annotations, no header files.

## Built-in LLM support

Milo ships a machine-readable language guide for LLMs:

```bash
milo skill    # prints a complete language guide optimized for LLM context windows
```

Pipe it into any AI tool as system context. The guide covers syntax, standard library, common patterns, and key rules — everything an LLM needs to generate correct Milo code on the first try.

## vs. C++: silent bugs

C++ lets wrong code compile. LLMs generate plausible C++ that works in testing and fails in production. These are the six most common failure modes.

### 1. Implicit conversions and type coercion

C++ `char` is simultaneously a character and an integer. `bool` promotes to `int`. Signed/unsigned comparison is legal but wrong. LLMs mix these freely.

```cpp
// C++ — compiles, wrong at runtime
char c = 200;           // implementation-defined: signed overflow on most platforms
if (c > 128) { ... }    // may be false — c could be -56

bool done = true;
int count = done + done; // count == 2. why not.

unsigned u = 0;
if (u - 1 > 0) { ... }  // true — wraps to 4294967295
```

```milo
// Milo — all three are compile errors
let c: u8 = 200         // fine — u8 is unsigned, explicit
let x: i32 = c          // ERROR: no implicit coercion, use `c as i32`

let done = true
let count = done + done  // ERROR: no bool arithmetic

let u: u32 = 0
let x = u - 1            // ERROR: unsigned underflow detected at compile time
```

### 2. Use-after-move / use-after-free

C++ moved-from objects are "valid but unspecified" — the most dangerous state possible. LLMs don't track move invalidation.

```cpp
// C++ — compiles, UB
std::vector<int> v = {1, 2, 3};
auto v2 = std::move(v);
v.push_back(4);          // UB: v is in "valid but unspecified" state
                          // might segfault, might silently corrupt memory
```

```milo
// Milo — compile error
var v = Vec.new()
v.push(1); v.push(2); v.push(3)
let v2 = v               // v moved to v2
v.push(4)                 // ERROR: use of moved value `v`
```

### 3. Dangling references

The most common C++ CVE pattern. LLMs routinely return references to locals or temporaries.

```cpp
// C++ — compiles with no warnings
std::string_view getName() {
    std::string s = "hello";
    return s;               // dangling — s destroyed at end of scope
}
// caller reads freed memory, might work in debug, segfault in release
```

```milo
// Milo — impossible by construction
fn getName(): &string {     // ERROR: cannot return a reference
    let s = "hello"
    return s
}
// second-class refs can't escape function scope. no lifetime annotations needed.
```

### 4. Null pointer dereference

LLMs forget null checks constantly. C++ has no mechanism to enforce them.

```cpp
// C++ — compiles, crashes
Widget* w = findWidget(id);
w->render();                // if findWidget returned nullptr, segfault
```

```milo
// Milo — must handle None
let w = findWidget(id)      // returns Option<Widget>
match w {
    Some(widget) => widget.render(),
    None => print("not found"),
}
// or: w!.render() — explicit crash if None, but intentional
```

### 5. Data races

C++ has no compile-time race prevention. LLMs share mutable state across threads without synchronization.

```cpp
// C++ — compiles, data race (UB per C++ standard)
int counter = 0;
std::thread t1([&]{ counter++; });
std::thread t2([&]{ counter++; });
// undefined behavior — compiler may optimize assuming no races
```

```milo
// Milo — compile error
var counter = 0
Thread.spawn(() => { counter += 1 })  // ERROR: `counter` is not Send
                                       // captured mutable reference can't cross thread boundary

// correct version:
let counter = AtomicI64.new(0)
Thread.spawn(move () => { counter.add(1) })  // OK — AtomicI64 is Send
```

### 6. Integer overflow

Signed overflow is UB in C++. LLMs write arithmetic without considering bounds.

```cpp
// C++ — UB, compiler may delete the overflow check entirely
int x = INT_MAX;
if (x + 1 > x) { ... }   // compiler assumes true (overflow is UB)
x = x + 1;                // "can't happen" — compiler optimizes based on this
```

```milo
// Milo — compile-time error for literals, runtime trap in debug
let x: i32 = 2147483647
let y = x + 1              // runtime trap in debug: arithmetic overflow
                            // use x.wrappingAdd(1) or x.saturatingAdd(1) for explicit semantics
```

## vs. Rust: borrow checker fights

Rust catches more errors than Milo — it has a full borrow checker with lifetime tracking. But LLMs can't reliably satisfy those constraints, leading to iteration loops where the LLM fights the compiler instead of writing features.

### Lifetime annotations confuse LLMs

LLMs write this perfectly reasonable code:

```rust
// Rust — won't compile
struct Parser {
    source: &str,  // needs Parser<'a> { source: &'a str }
}

fn parse(input: &str) -> Vec<&str> {  // needs lifetime annotations
    // ...
}
```

LLMs either forget lifetime annotations, add them wrong, or over-annotate with `'static` (which forces `.clone()` everywhere). The iteration loop of "LLM writes code → compiler rejects → LLM tries to fix lifetimes → makes it worse" is a well-documented failure mode.

```milo
// Milo — no lifetimes, ever
fn parse(input: &string): Vec<string> {
    // references are param-only, returned data must be owned
    // no annotations needed, no borrow checker fights
}
```

### Trait bounds cascade

LLMs write generic Rust, then hit cascading errors:

```rust
// Rust — "the trait `Clone` is not implemented for `T`"
fn process<T>(items: Vec<T>) -> Vec<T> {
    items.iter().map(|x| x.clone()).collect()  // needs T: Clone
    // then needs T: Debug for error messages
    // then needs T: Send for threading
    // each fix reveals the next missing bound
}
```

Milo uses monomorphization — generics are resolved at compile time without trait bound cascading. If `T` doesn't have `.clone()`, the error points at the specific instantiation site, not a chain of abstract bounds.

### Ownership puzzles

Rust's borrow checker enforces rules that are correct but require restructuring code in non-obvious ways:

```rust
// Rust — won't compile (can't borrow mutably while iterating)
let mut v = vec![1, 2, 3];
for x in &v {
    if *x > 2 { v.push(*x); }  // ERROR: can't mutate while borrowed
}
```

An LLM tries to "fix" this with `.clone()`, `RefCell`, or `unsafe` instead of restructuring. Milo's simpler ownership model — move or clone, no shared mutable borrows — means fewer of these puzzles arise.

### The tradeoff

Rust catches more bugs at compile time. But the cost is a higher precision floor that LLMs can't reliably meet. C++ lets wrong code compile silently (UB). Rust rejects correct-in-spirit code that violates borrow rules. Both are bad for LLMs, for opposite reasons. Milo threads the needle: strict enough to catch real bugs, simple enough that correct-in-spirit code actually compiles.

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
| Precision floor | Very high | High (lifetimes) | Low | LLMs write correct code on first try |
