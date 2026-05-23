# Milo Language Design

## Position

Use instead of C. Use instead of Rust when you don't need Rust's full power.
Not "learn before Rust" — that requires years of pedagogical tooling.

## Core Principles

- `let` = immutable (SSA register in LLVM IR)
- `var` = mutable (alloca in LLVM IR)
- Cost model is visible — syntax tells you what LLVM will do
- No pointers in safe code. Period.
- No garbage collector. No reference counting.

## The Three Safety Mechanisms

### 1. Move Semantics (Default)

Values have a single owner. Assignment transfers ownership. Use after move is a compile error.

```
let a = File.open("data.txt")
let b = a                      // a is moved into b
// a is now invalid — compile error if used
```

Small value types can opt into Copy:

```
struct Vec2 { x: f64, y: f64 }
impl Copy for Vec2 {}
```

### 2. Second-Class References (No Lifetimes)

References (`&T`, `&mut T`) can appear as function parameters and local variables, but cannot be returned from functions or stored in structs/collections. Dangling references are impossible by construction — no lifetime annotations needed.

```
fn process(content: &string): void {
    let view = content[0..80]   // zero-copy &string slice (cap=0, no malloc)
    let byte = view[0]          // indexing works through auto-deref
    print(view.len)             // methods work through auto-deref
}

fn bad(): &string {             // COMPILE ERROR: can't return a reference
    // ...
}

struct Bad {
    ref: &string                // COMPILE ERROR: can't store a reference
}
```

#### Why not lifetimes?

We studied ~1,200 lifetime annotations across ripgrep and deno. Roughly 70% were zero-copy views into owned data — slicing a string, iterating a vec, passing a buffer to a function. Milo covers all of these with second-class refs + zero-copy slices + `for` loops.

The remaining 30% are patterns like structs holding borrowed fields (`Parser<'a>` with `&'a str`), iterators yielding borrowed data, and `Cow<'a, T>`. These require lifetime annotations to express. Milo's answer: restructure around functions (pass `&string` as a param instead of storing it in a struct) or just own the data. This is slightly less flexible but eliminates an entire class of complexity.

The tradeoff is real — you can't write `struct LineIter { source: &string }`. But the typical workaround (a function that takes `&string` and a callback, or a `for` loop) is 2-3 lines of difference, not a fundamental limitation. Most well-structured Rust code naturally gravitates toward this style anyway.

### 3. Bounds-Checked Arrays

Array access is checked at runtime. Out-of-bounds = clear panic, not silent corruption.

## Type System

### Primitives
`i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `f32`, `f64`, `bool`

### Structs
```
struct Point { x: f64, y: f64 }
```

### Enums (Sum Types)
```
enum Option<T> {
    Some(T),
    None,
}

enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

### Pattern Matching
```
match result {
    Ok(v)  => print(v),
    Err(e) => print(e),
}
```

### Generics
```
fn identity<T>(val: T) -> T { val }
```

## Arenas (Deferred)

Arenas handle recursive and cyclic data structures. Deferred until self-hosting reveals real API needs.

Design direction:
- `Arena<T>` — typed, homogeneous, language built-in
- `Ref<T>` — a Copy value type containing `(index: u32, gen: u32)`
- Generational index catches use-after-remove at runtime

What arenas unlock: trees with parent pointers, doubly-linked lists, arbitrary graphs, ECS.

What works fine WITHOUT arenas: CLI tools, parsers, compilers, HTTP servers, file processors.

## FFI Strategy

C interop from day one via LLVM IR call declarations. The goal: keep `unsafe` at the thinnest possible seam.

```
extern fn puts(s: *u8): i32
extern fn malloc(size: u64): *u8
```

### Safe extern calls

An extern call is safe (no `unsafe` needed) when:
- All pointer params receive auto-coerced args (`string`→`*u8`, `[T;N]`→`*T`, matching `*T`)
- Function-typed params receive matching Milo functions
- Return is scalar or `void`

Calls returning `*T` still require `unsafe` — unknown provenance.

```
// Safe — string auto-coerces, return is i32
puts("hello")

// Unsafe — malloc returns *u8
unsafe { let p = malloc(64) }
```

### Opaque foreign types

`extern type` declares a type with no known layout — can only exist behind `*T`:

```
extern type sqlite3
extern fn sqlite3_open(path: *u8, db: **sqlite3): i32
```

`*sqlite3` is distinct from `*u8` and other `*ExternType` — prevents handle mixups at compile time.

### Extern structs

`extern struct` declares a C-layout struct. Field access through `*ExternStruct` uses GEP (requires `unsafe` for the deref):

```
extern struct SockAddrIn { sin_family: u16, sin_port: u16, sin_addr: u32 }
```

### string.cstr()

Returns `*u8` data pointer without `unsafe`. Non-owning borrow — the string stays alive in the caller's scope.

### Typed function pointers

Extern declarations accept function-typed params directly. No `as *u8` cast needed:

```
extern fn qsort(base: *u8, num: i64, size: i64, cmp: (*u8, *u8) => i32): void
qsort(arr.cstr(), 5, 4, myCmpFn)   // myCmpFn passed directly
```

## Compiler Pipeline

```
Source → Lexer → Parser → AST → [Type Checker → HIR] → Codegen → LLVM IR → clang → Binary
```

Frontend: TypeScript (Bun). Backend: LLVM toolchain.

## Differentiators

| | Milo | Rust | C | Zig |
|---|---|---|---|---|
| Memory safety | Yes (moves + second-class refs) | Yes (lifetimes + borrow checker) | No | Partial |
| Null safety | Yes (Option\<T\>) | Yes (Option\<T\>) | No | No |
| Race safety | Yes (Send/Sync, compile-time) | Yes (Send/Sync, compile-time) | No | No |
| Overflow safety | Yes (compile-time + debug traps) | Yes (compile-time + debug panics) | No (UB) | Yes (always trap) |
| Coercion safety | Yes (no implicit coercions) | Yes | No | Yes |
| Cyclic data | Index-based or arenas | Painful | Easy (unsafe) | Manual |
| Lifetime annotations | None | Required | N/A | None |
| Learning curve | Low (goal) | High | Medium then deadly | Medium |
| GC | No | No | No | No |

## AI-Assisted Development ("Vibe Coding")

LLMs generate plausible code fast but reason poorly about implicit rules, undefined behavior, and cross-cutting invariants. Languages with narrow, explicit semantics produce better AI-generated code because the compiler catches what the LLM misses. Milo is designed so that **wrong code fails to compile, not fails silently at runtime**.

### C++ Pitfalls LLMs Hit Constantly

**1. Implicit conversions and type coercion**

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

**2. Use-after-move / use-after-free**

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

**3. Dangling references**

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

**4. Null pointer dereference**

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

**5. Data races**

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

**6. Integer overflow**

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

### Why This Matters for AI Code Generation

| Property | C++ | Milo | Impact on LLM-generated code |
|---|---|---|---|
| Implicit conversions | ~15 built-in | Zero | LLMs can't introduce silent type bugs |
| Undefined behavior | 200+ categories | None in safe code | Wrong code crashes loud, not silent |
| Null | Raw pointers, everywhere | `Option<T>`, exhaustive match | Compiler forces null handling |
| Memory safety | Manual (RAII helps, doesn't enforce) | Compile-time moves + second-class refs | Use-after-free/move = compile error |
| Thread safety | Nothing enforced | Send/Sync at compile time | Data races can't compile |
| Error handling | Exceptions (invisible control flow) | `Result<T,E>` + `?` (visible) | Error paths can't be accidentally ignored |
| Build complexity | Headers, includes, ODR, templates | Single files, simple imports | Less surface area for LLM confusion |

### The Precision Floor

Every language has a **precision floor** — the minimum level of detail a programmer must get right for correct code. C++ has the highest precision floor of any mainstream language: you must reason about move semantics, lifetime rules, implicit conversions, undefined behavior, template instantiation, header inclusion order, and more — simultaneously.

LLMs operate above the precision floor for Python and TypeScript. They operate **below** it for C++. Milo is designed to keep the precision floor as low as possible for a systems language: if you get the types and ownership right, the compiler handles the rest. No implicit conversions, no UB, no lifetime annotations, no header files.

The result: LLM-generated Milo code either compiles and is correct, or fails with a clear error message. There is no middle ground where code compiles, appears to work, and has a latent memory safety bug. That middle ground is where C++ CVEs live.

## Resolved Design Decisions

- **Traits** — nominal traits with monomorphized static dispatch, `impl Trait for Type`, inherent `impl Type`, generic bounds, supertraits, `@derive`.
- **Interfaces** — Go-style runtime polymorphism with structural typing. `interface Greeter { fn greet(self: &Self): string }` — any type with matching methods satisfies it. Fat pointer dispatch via itables. Separate from traits (compile-time only).
- **Error handling** — `Result<T, E>` + `Option<T>` with `!` (unwrap), `?` (propagate), `??` (default). No try/catch.
- **String type** — owned UTF-8 `{ ptr, len, cap }`, heap-allocated. `s[a..b]` returns zero-copy `&string` slice (cap=0). `.substr(a, b)` for owned copy. `clone`, `push`, `+`, `==`, byte indexing, functional methods on Vec.
- **Module/import system** — `import "path.milo"` and `from "path" import { names }`, recursive resolution, dedup.

## Resolved Safety Model

Milo enforces five compile-time safety guardrails:
- **Memory safe** — move semantics, use-after-move errors, bounds-checked arrays, no dangling pointers
- **Null safe** — no null; `Option<T>` with exhaustive matching
- **Race safe** — Send/Sync traits, `spawn()` rejects non-Send captures at compile time
- **Overflow safe** — compile-time literal/const checks, debug-mode runtime traps via LLVM intrinsics
- **Coercion safe** — no implicit type coercions, explicit `as` casts only

## Concurrency Model

Two layers: OS threads for CPU-bound parallelism, green threads for high-concurrency I/O. No async/await — blocking I/O automatically yields in green thread context.

### OS Threads

- **`spawn()`** — OS thread with move closure. Compiler enforces Send on all captures.
- **`parallel { let a = ...; let b = ... }`** — structured concurrency block. Runs N expressions on N threads, joins all before continuing. Bindings scoped to parent.
- **Channels** — bounded FIFO (`ch.send()`/`ch.recv()`), plus non-blocking `ch.trySend()`/`ch.tryRecv()`.
- **Mutex** — pthread-based, with `withLock` closure helper.
- **RwLock** — multiple readers OR one writer, with `withReadLock`/`withWriteLock`.
- **Atomics** — `AtomicI64`, `AtomicBool` backed by LLVM `atomicrmw`/`cmpxchg`/`load atomic`/`store atomic` (seq_cst).
- **`@send`/`@sync`** — annotations for user types wrapping unsafe internals. Replaces hardcoded whitelist.

### Green Threads

Stackful coroutines via `ucontext` with cooperative scheduling. Each green thread gets a 64KB stack (with guard page) instead of an 8MB OS thread stack — can run 10K+ concurrently.

- **`Task.spawn(f)`** — spawn a green thread. Returns `Task`.
- **`schedulerYield()`** — cooperatively yield to other green threads.
- **`schedulerWaitRead(fd)` / `schedulerWaitWrite(fd)`** — yield until fd is ready (kqueue on macOS, epoll on Linux).
- **Transparent async I/O** — `stream.recv()`/`stream.send()` detect green thread context, automatically set non-blocking and yield on EAGAIN. User code reads the same whether in OS thread or green thread.
- **Implicit drain** — compiler injects `_schedulerDrain()` at end of main when program uses green threads. No manual event loop.

Design: same `read()` call works in both OS threads and green threads. No `async`/`await` keywords, no `Future` types. I/O functions check `schedulerCurrent()` at runtime to decide between blocking and yielding.

## Open Questions

- Arena API shape (deferred until self-hosting reveals real needs)

## Alignment with Graydon Hoare's "The Rust I Wanted"

In [a 2023 blog post](https://graydon2.dreamwidth.org/307291.html), Graydon Hoare — Rust's original designer — listed the design choices he wanted for Rust but lost to community pressure or LLVM constraints. Many of Milo's design decisions independently align with his preferred direction. This wasn't intentional; it's convergent evolution toward the same "simplicity over expressivity" philosophy.

### Where Milo aligns

| Hoare's preference | Why Rust couldn't | Milo |
|---|---|---|
| **Move semantics as default** | Rust eventually adopted this | ✅ Default from day one |
| **Built-in containers** (not library-defined) | Rust's Vec/HashMap are regular library code using generics + unsafe. Requires aggressive cross-crate inlining for perf, hurting compile times. | ✅ Vec, HashMap, string have direct compiler support — codegen knows their layout and emits operations without going through generic trait dispatch |
| **Interior iteration** (no stored iterator refs) | LLVM couldn't do coroutines at the time | ✅ `for x in vec` is built-in, no iterator objects or stored references |
| **Green threads, not async/await** | Go-style FFI issues, ripped out twice | ✅ `Task.spawn` with cooperative scheduling, no async/await |
| **Second-class `&` references** | Iterators needed first-class refs to store collection pointers | ✅ References are param/local only, never stored or returned |
| **No explicit lifetimes** | Forced by first-class references | ✅ No lifetimes, ever |
| **Simple type inference** (local only) | Type system people won, inference grew complex | ✅ Local inference only, no unification puzzles |
| **Simple grammar** | Lost every argument (angle brackets, semicolons, etc.) | ✅ Recursive descent, LL-friendly, no ambiguities |
| **Error handling as first-class** | 1.0 shipped a void, `?` added later from Swift | ✅ Result<T,E> + `?` + `!` + `??` from day one |
| **Simplicity over zero-cost abstraction** | Community prioritized C++-competitive perf | ✅ Milo's core ethos — simple and fast enough, not zero-cost-at-all-costs |
| **Integer overflow safety** | Rust traps in debug only; Hoare wanted more | ✅ Compile-time checks + debug traps + explicit wrapping/saturating methods |

### Where Milo diverges (pragmatic choices)

| Hoare's preference | Why Milo chose differently |
|---|---|
| **No traits** (wanted ML modules) | Traits are more ergonomic and familiar to most developers. ML modules are powerful but verbose. Milo keeps traits simple: no HKTs, no GATs, no complex associated types. |
| **No environment capture in closures** | Closures with capture are too useful for `map`/`filter`/functional patterns. Milo mitigates with explicit `move` closures for escaping captures. |
| **Erlang-style actors only** | Too limiting. Threads + channels + green threads covers more use cases. |
| **Structural types** | Nominal types work better with traits and are easier to produce clear error messages for. |

### Where Milo hasn't gone yet

| Hoare's preference | Status |
|---|---|
| **Tail calls** | Not implemented. Could add for state machines. |
| **Auto-bignum integers** | Not implemented. Would be a compiler built-in if added. |
| **Decimal floating point** | Not implemented. |
| **Reflection** | Not implemented. Compile-time reflection via type descriptors is a possibility. |
| **Better existentials / dyn dispatch** | Deferred. Could enable dynamic linking and runtime extension. |

### The meta-lesson

Hoare's core thesis: he would have traded performance and expressivity for simplicity, and the resulting language would have been less popular. Milo bets that with hindsight, a fresh codebase, and AI-assisted development, you can have both: a language simple enough to learn in a weekend that's still fast enough for real systems work. Many of the constraints that forced Rust's complexity (LLVM limitations, need for library-defined containers, iterator patterns) simply don't apply when you design around them from the start.

## Prior Art

- **Austral** — second-class references, linear types, minimal design
- **Vale** — generational references, region-based memory
- **Hylo** — value semantics, mutable value semantics (formalized second-class refs in academic paper)
- **Zig** — comptime, explicit allocators, C interop
- **Elm** — error messages as a design priority
- **Lobster** — compile-time lifetime analysis without annotations
