# Milo Language Design

Design decisions and rationale. Syntax and semantics live in [language-reference.md](language-reference.md); this doc covers *why*.

## Position

Use instead of C. Use instead of Rust when you don't need Rust's full power.
Not "learn before Rust" — that requires years of pedagogical tooling.

## Core Principles

- `let` = immutable (SSA register), `var` = mutable (alloca) — the cost model is visible; syntax tells you what LLVM will do
- No pointers in safe code
- No garbage collector, no reference counting
- No lifetime annotations, ever

## The Three Safety Mechanisms

### 1. Move semantics (default)

Values have a single owner. Assignment transfers ownership; use after move is a compile error. Small value types opt in to copying with `impl Copy for Vec2 {}`.

### 2. Second-class references (no lifetimes)

`&T` and `&mut T` can be function params and locals, but can never be returned from a function or stored in a struct/collection. Dangling references are impossible by construction.

```
fn process(content: &string): void {
    let view = content[0..80]   // zero-copy &string slice (cap=0, no malloc)
    print(view.len)             // indexing and methods work through auto-deref
}

fn bad(): &string { ... }       // COMPILE ERROR: can't return a reference
struct Bad { ref: &string }     // COMPILE ERROR: can't store a reference
```

**Why not lifetimes?** We studied ~1,200 lifetime annotations across ripgrep and deno. Roughly 70% were zero-copy views into owned data — slicing a string, iterating a vec, passing a buffer. Second-class refs + zero-copy slices + `for` loops cover all of those. The remaining 30% (structs holding borrowed fields like `Parser<'a>`, iterators yielding borrows, `Cow<'a, T>`) cannot be expressed. Milo's answer: restructure around functions (pass `&string` as a param instead of storing it) or own the data. The tradeoff is real — no `struct LineIter { source: &string }` — but the workaround (a function taking `&string` plus a callback, or a `for` loop) is a 2–3 line difference, and well-structured Rust code gravitates toward this style anyway.

### 3. Bounds-checked arrays

Array access is checked at runtime. Out-of-bounds = clear panic, not silent corruption.

## Safety Model

Five compile-time guardrails:

- **Memory safe** — moves, use-after-move errors, bounds checks, no dangling references
- **Null safe** — no null; `Option<T>` with exhaustive matching
- **Race safe** — Send/Sync; `spawn()` rejects non-Send captures
- **Overflow safe** — compile-time literal/const checks, debug-mode runtime traps
- **Coercion safe** — no implicit coercions; explicit `as` casts only

Ongoing work on aliasing/invalidation gaps: [safety-roadmap.md](safety-roadmap.md).

## Resolved Design Decisions

- **Traits** — nominal, monomorphized static dispatch; `impl Trait for Type`, inherent impls, generic bounds, supertraits, `@derive`. No HKTs, no GATs, no complex associated types.
- **Interfaces** — Go-style structural runtime polymorphism, fat-pointer itable dispatch. Deliberately separate from traits (compile-time only).
- **Error handling** — `Result<T, E>` + `Option<T>` with `!` (unwrap), `?` (propagate), `??` (default). No try/catch.
- **Strings** — owned UTF-8 `{ptr, len, cap}`; `s[a..b]` is a zero-copy `&string` slice (cap=0), `.substr(a, b)` copies.
- **Modules** — `import "path.milo"` and `from "path" import { names }`; recursive resolution, dedup.
- **Arenas (deferred)** — `Arena<T>` + generational `Ref<T>` (`index: u32, gen: u32`, Copy) for cyclic data: trees with parent pointers, doubly-linked lists, graphs, ECS. Deferred until self-hosting reveals real API needs — CLI tools, parsers, compilers, HTTP servers, and file processors don't need them.

## Concurrency

One model — green tasks — with a single OS-thread escape hatch. No async/await, no `Future` types, no function coloring:

- **Green tasks** are the default — `Task.spawn(f)` / `Promise<T>.run(f)`: stackful coroutines via ucontext, 64KB guarded stacks (10K+ concurrent), cooperative scheduling with `schedulerYield()` and fd-readiness waits (kqueue/epoll). `Promise`/`Channel`/`select`/`WaitGroup` all park the task, not the OS thread, and compose freely. Collect results with `.await()`; `Promise.all`/`Promise.race` for fan-out.
- **`Promise.blocking(f)`** is the one escape hatch to a real OS thread — for CPU-bound work or blocking FFI that would otherwise starve the single-threaded cooperative scheduler. Its captures must be `Send` (compiler-enforced); the result comes back through the same `await`. Shared state across parallel workers goes through channels or `AtomicI64`/`AtomicBool` (seq_cst). `@send`/`@sync` annotate user types wrapping unsafe internals. (Public `Thread`/`Mutex`/`RwLock`/`parallel` were removed 2026-07-10 — see [concurrency-simplification.md](concurrency-simplification.md).)

The key design point: the same blocking `stream.recv()` works in a task and on a `Promise.blocking` thread. I/O functions check `schedulerCurrent()` at runtime — in a green task they set non-blocking and yield on EAGAIN; on an OS thread they block. Exit semantics are Go's: when `main` returns the process exits and outstanding tasks are abandoned — wait explicitly (`join`, `WaitGroup`, `Promise`, channel) or `schedulerRunToCompletion()`. No manual event loop, no scheduler auto-drain.

## FFI

C interop from day one; keep `unsafe` at the thinnest possible seam.

- **Safe extern calls** — no `unsafe` needed when all pointer params receive auto-coerced args (`string`→`*u8`, `[T;N]`→`*T`, matching `*T`), function-typed params receive matching Milo functions, and the return is scalar or `void`. Calls returning `*T` still require `unsafe` — unknown provenance.
- **`extern type sqlite3`** — opaque foreign handles, only exist behind `*T`; each extern type is distinct, preventing handle mixups at compile time.
- **`extern struct`** — C-layout structs; field access through `*ExternStruct` uses GEP and requires `unsafe`.
- **`string.cstr()`** — non-owning `*u8` borrow without `unsafe`; the string stays alive in the caller's scope.
- **Typed function pointers** — extern decls take `(*u8, *u8) => i32` params directly; matching Milo fns pass with no cast.

## Pipeline

```
Source → Lexer → Parser → AST → Type Checker → HIR → Codegen → LLVM IR → clang → Binary
```

Frontend: TypeScript (Bun). Backend: LLVM. Self-hosted port in progress ([self-hosting.md](self-hosting.md)).

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

The C++ pitfalls LLMs hit constantly, and what Milo does instead:

1. **Implicit conversions** — `char`/`int` blurring, `bool` arithmetic, signed/unsigned comparison. Milo: zero implicit coercions; all compile errors.
2. **Use-after-move** — C++ moved-from objects are "valid but unspecified"; LLMs don't track invalidation. Milo: compile error.
3. **Dangling references** — the most common C++ CVE pattern; LLMs routinely return refs to locals. Milo: impossible by construction.
4. **Null deref** — LLMs forget null checks; C++ can't enforce them. Milo: `Option<T>` with exhaustive match.
5. **Data races** — LLMs share mutable state across threads freely. Milo: non-Send captures rejected at compile time.
6. **Integer overflow** — signed overflow is UB; C++ compilers delete overflow checks based on it. Milo: compile-time checks for constants, debug traps, explicit `wrappingAdd`/`saturatingAdd`.

Two examples of the pattern:

```cpp
// C++ — compiles, UB
std::vector<int> v = {1, 2, 3};
auto v2 = std::move(v);
v.push_back(4);          // "valid but unspecified" — may silently corrupt
```
```milo error
// Milo — compile error
var v: Vec<i64> = Vec.new()
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

| Property | C++ | Milo | Impact on LLM-generated code |
|---|---|---|---|
| Implicit conversions | ~15 built-in | Zero | LLMs can't introduce silent type bugs |
| Undefined behavior | 200+ categories | None in safe code | Wrong code crashes loud, not silent |
| Null | Raw pointers, everywhere | `Option<T>`, exhaustive match | Compiler forces null handling |
| Memory safety | Manual (RAII helps, doesn't enforce) | Compile-time moves + second-class refs | Use-after-free/move = compile error |
| Thread safety | Nothing enforced | Send/Sync at compile time | Data races can't compile |
| Error handling | Exceptions (invisible control flow) | `Result<T,E>` + `?` (visible) | Error paths can't be accidentally ignored |
| Build complexity | Headers, includes, ODR, templates | Single files, simple imports | Less surface area for LLM confusion |

**The precision floor.** Every language has a minimum level of detail a programmer must get right for correct code. C++ has the highest of any mainstream language — moves, lifetimes, implicit conversions, UB, template instantiation, header order, simultaneously. LLMs operate above the floor for Python and TypeScript, below it for C++. Milo keeps the floor as low as a systems language allows: get types and ownership right and the compiler handles the rest. LLM-generated Milo either compiles and is correct, or fails with a clear error — there is no middle ground where code compiles, appears to work, and hides a latent memory-safety bug. That middle ground is where C++ CVEs live.

## Alignment with Graydon Hoare's "The Rust I Wanted"

In [a 2023 blog post](https://graydon2.dreamwidth.org/307291.html), Rust's original designer listed the design choices he wanted but lost to community pressure or LLVM constraints. Many of Milo's decisions independently align — convergent evolution toward "simplicity over expressivity":

| Hoare's preference | Why Rust couldn't | Milo |
|---|---|---|
| **Move semantics as default** | Rust eventually adopted this | ✅ Default from day one |
| **Built-in containers** | Vec/HashMap are library code needing aggressive cross-crate inlining, hurting compile times | ✅ Vec, HashMap, string have direct compiler support |
| **Interior iteration** | LLVM couldn't do coroutines at the time | ✅ `for x in vec` is built-in, no iterator objects |
| **Green threads, not async/await** | Go-style FFI issues, ripped out twice | ✅ `Task.spawn` with cooperative scheduling |
| **Second-class `&` references** | Iterators needed first-class refs | ✅ Refs are param/local only |
| **No explicit lifetimes** | Forced by first-class references | ✅ No lifetimes, ever |
| **Simple local-only type inference** | Type system people won | ✅ Local inference only |
| **Simple grammar** | Lost every argument | ✅ Recursive descent, LL-friendly |
| **First-class error handling** | 1.0 shipped a void; `?` came later | ✅ Result + `?`/`!`/`??` from day one |
| **Simplicity over zero-cost abstraction** | Community prioritized C++-competitive perf | ✅ Core ethos |
| **Integer overflow safety** | Debug-only traps; Hoare wanted more | ✅ Compile-time checks + debug traps + explicit wrapping/saturating |

Deliberate divergences: traits instead of ML modules (more ergonomic, kept simple); closures capture their environment (too useful for `map`/`filter`; escaping captures need explicit `move`); threads + channels instead of actors-only; nominal types instead of structural (clearer errors, better with traits). Not adopted (yet): tail calls, auto-bignum, decimal floats, reflection, richer dyn dispatch.

The meta-lesson: Hoare would have traded performance and expressivity for simplicity, expecting less popularity. Milo bets that with hindsight, a fresh codebase, and AI-assisted development, you can have both — the constraints that forced Rust's complexity (LLVM-era limitations, library-defined containers, stored iterators) don't apply when you design around them from the start.

## Open Questions

- Arena API shape (deferred until self-hosting reveals real needs)

## Prior Art

- **Austral** — second-class references, linear types, minimal design
- **Vale** — generational references, region-based memory
- **Hylo** — mutable value semantics (formalized second-class refs academically)
- **Zig** — comptime, explicit allocators, C interop
- **Elm** — error messages as a design priority
- **Lobster** — compile-time lifetime analysis without annotations
