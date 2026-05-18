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

C interop from day one via LLVM IR call declarations:

```
extern fn puts(s: *u8) -> i32
extern fn malloc(size: u64) -> RawPtr
```

FFI is the escape hatch for anything the language can't do yet.

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

## Resolved Design Decisions

- **Traits** — nominal traits with monomorphized static dispatch, `impl Trait for Type`, inherent `impl Type`, generic bounds, supertraits, `@derive`. No vtables (dyn Trait deferred).
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

Two layers: OS threads for CPU-bound parallelism, green threads for high-concurrency I/O. No async/await, no function coloring. Blocking I/O automatically yields in green thread context.

### OS Threads

- **`spawn()`** — OS thread with move closure. Compiler enforces Send on all captures.
- **`parallel { let a = ...; let b = ... }`** — structured concurrency block. Runs N expressions on N threads, joins all before continuing. Bindings scoped to parent.
- **Channels** — bounded FIFO (`channelSend`/`channelRecv`), plus non-blocking `channelTrySend`/`channelTryRecv`.
- **Mutex** — pthread-based, with `withLock` closure helper.
- **RwLock** — multiple readers OR one writer, with `withReadLock`/`withWriteLock`.
- **Atomics** — `AtomicI64`, `AtomicBool` backed by LLVM `atomicrmw`/`cmpxchg`/`load atomic`/`store atomic` (seq_cst).
- **`@send`/`@sync`** — annotations for user types wrapping unsafe internals. Replaces hardcoded whitelist.

### Green Threads

Stackful coroutines via `ucontext` with cooperative scheduling. Each green thread gets a 64KB stack (with guard page) instead of an 8MB OS thread stack — can run 10K+ concurrently.

- **`greenSpawn(f)`** — spawn a green thread. Returns `TaskHandle`.
- **`schedulerYield()`** — cooperatively yield to other green threads.
- **`schedulerWaitRead(fd)` / `schedulerWaitWrite(fd)`** — yield until fd is ready (kqueue on macOS, epoll on Linux).
- **Transparent async I/O** — `tcpRecv`/`tcpSend` detect green thread context, automatically set non-blocking and yield on EAGAIN. User code reads the same whether in OS thread or green thread.
- **Implicit drain** — compiler injects `_schedulerDrain()` at end of main when program uses green threads. No manual event loop.

Design: no function coloring (same `read()` call works in both contexts), no `async`/`await` keywords, no `Future` types. I/O functions check `schedulerCurrent()` at runtime to decide between blocking and yielding.

## Open Questions

- Arena API shape (deferred until self-hosting reveals real needs)

## Prior Art

- **Austral** — second-class references, linear types, minimal design
- **Vale** — generational references, region-based memory
- **Hylo** — value semantics, mutable value semantics
- **Zig** — comptime, explicit allocators, C interop
- **Elm** — error messages as a design priority
- **Lobster** — compile-time lifetime analysis without annotations
