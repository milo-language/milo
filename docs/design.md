<!-- doc-meta
system: language-design
purpose: the why behind Milo's design decisions — memory model, references, concurrency, error handling
key-files: docs/language-reference.md, src/checker.ts, std/arena.milo
update-when: a design decision changes, a deferred feature ships, or a fence/tradeoff is revised
last-verified: 2026-07-22
-->

# Milo Language Design

Design decisions and rationale. Syntax and semantics live in [language-reference.md](language-reference.md); this doc covers *why*.

## Ethos

**Safe, readable, and provable by default — full low-level control one keyword away.**

The compiler is a collaborator, not a gate. It makes the correct path the path of
least resistance, then stays out of the way. Seven principles, in priority order —
**when two conflict, the lower number wins** (precedent: array bounds checks stay
on in release, #1, despite a measured runtime cost, #5):

1. **No silent footgun.** Every hazard is a compile error, never a wrong answer at
   runtime. If the compiler can't rule a mistake out, it says so — it does not guess.
2. **The correct path is the default path.** You fall into single-owner, memory-safe,
   readable structure without trying. The compiler guides the code into simple something readable and comprehensible.
3. **The language stays small.** Every feature is paid for in cognitive load, checker
   complexity, and provability, so expressivity is traded away deliberately: no
   metaprogramming, no lifetimes, no associated types, traits frozen at their current
   scope, eager combinators over lazy adapters. One way to do a thing beats two.
   A rejected feature is a decision, recorded so it doesn't get re-pitched.
4. **Safety by construction, not annotation.** Move semantics + second-class references
   + bounds checks give memory safety with *no lifetimes, ever*. The unsafe thing is
   unsayable, not merely discouraged — so there is nothing to prove to the compiler.
5. **Visible, minimal cost.** `let`/`var` expose what the machine does; no hidden GC,
   no hidden dispatch, no hidden allocation. Ideally zero overhead — a little, if it
   buys safety, and only where you can see it.
6. **Provable, not just safe.** Contracts → SMT discharge → DO-178C. Correctness you
   can demonstrate to a certifier, not merely believe. This is the destination the
   other principles clear the road for.
7. **Explicit escape hatches.** `unsafe`, raw pointers, wrapping arithmetic, full memory
   control — opt-in, visible, and confined to where you asked for them. The guardrails
   are the default, not a cage; when you need C's power you take it deliberately, and the
   reviewer can see exactly where.

The bet (vs [Graydon Hoare's retrospective](graydon-review.md)): he would have traded
performance and expressivity for simplicity, expecting less popularity. Milo bets that
with hindsight, a fresh codebase, and AI-assisted development you need not trade at all —
the constraints that forced Rust's complexity don't apply when you design around them from
the start. Milo isn't refighting Rust's 2010 war (dethrone C++ on raw speed at any
complexity cost), and it doesn't accept the old safety-critical trade either (Ada/SPARK's
"slower and bureaucratic, but certifiable"). It takes SPARK's best ideas — ranged types,
contracts, proof — without the perf surrender: a check the compiler can prove unnecessary
is deleted, one it can't is kept and cheap, and the escape hatches are there when you've
measured. Fast and provably safe, not one or the other.

**In one line: SPARK's guarantees without SPARK's ceremony, in a language people would
pick anyway.** The proof-then-delete-checks pipeline is not a gamble — it is SPARK's
production practice (prove absence of runtime errors, compile with checks suppressed;
30 years of avionics/rail/NVIDIA-firmware mileage). What has never existed is that
pipeline as the *default path* of a language with mainstream ergonomics — enums + match,
closures, inference, green threads, contracts as plain syntax the same person writes.
"People would pick it anyway" is a safety property, not marketing: languages nobody
dogfoods for fun never get the feedback loop that hardens them (Milo's emulators and CLI
tools are where its papercuts get found). Nearest relatives, for calibration: SPARK has
the proof but not the ergonomics; Rust has the ergonomics but chose lifetime/trait
complexity; Hylo shares the no-lifetimes bet (second-class refs / mutable value
semantics) but remains a research language. The combination is the contribution.

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

**No `&mut` at the callsite.** Milo auto-borrows arguments — you write `f(x)`, not `f(&mut x)`, even when `f` takes `&mut T`. Rust requires the callsite marker because `&mut` is an *exclusive* borrow and the marker is load-bearing for aliasing analysis. Milo's references are second-class — never stored, returned, or aliased — so an exclusive borrow cannot escape a call or overlap another live reference. The aliasing danger that makes Rust's marker earn its keep cannot occur here, so the marker would be pure ceremony. Mutation intent is carried by the function signature and name; reader-side visibility is delegated to the LSP, which will render the elided `&mut` as an inlay hint at the callsite (planned) rather than baking it into the syntax.

**But immutable bindings still can't be passed to `&mut`.** The one real hazard the callsite marker would have caught is *evolution*: a function that switches `&T` → `&mut T` starts mutating its caller's data with no callsite change. Milo closes this at the binding, not the callsite — a `let` binding (or any immutable binding: a `for` variable, a match-arm payload) **cannot** be passed to a `&mut` parameter:

```
let x = 5
bump(x)          // COMPILE ERROR: cannot pass immutable 'x' as a '&mut' argument
var x = 5
bump(x)          // ok — 'x' is declared mutable
```

This is a soundness rule, not a style choice: `let` means *immutable, SSA-register*, and taking its address for a `&mut` write would silently spill it to memory and mutate it — breaking both halves of what `let` promises. It also mirrors what method receivers already enforce (`v.push(...)` on a `let` Vec is rejected). So an `&T` → `&mut T` change is loud exactly for the callers who declared their data immutable, and silent only for those who already opted into mutation with `var` — the safety of the marker, without the ceremony.

**The fence: second-class is final.** `&T` will never gain storage, return, or generic-storage rights. Every future ergonomic pressure on references — iterators holding borrows, borrowed struct fields, returned views — routes to spans, arenas, or restructuring around functions, never to loosening the reference rules. Each exception would be the first step back toward lifetimes; the model only stays annotation-free if the door stays shut. Hylo reaches the same place from the other direction: its `let`/`inout` parameter conventions compile to frame-confined references — no reference type in the surface language at all. Milo keeps the Rust-familiar `&T` spelling with the same semantics; what Hylo makes unrepresentable, Milo forbids by rule, and this paragraph is the commitment that the rule holds.

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
- **Semicolons (cosmetic)** — statements are newline/grammar-delimited; a trailing, same-line-separating, or empty `;` is a tolerated no-op, so habitual `;` never hits a wall. It is *not* semantic (unlike Rust, a `;` never voids a block tail — block value is positional: the last expr-statement is the value). The formatter strips statement-level `;`, keeping the load-bearing `;` in `[T; N]`; a `;` *inside* an expression is still a parse error. Net: canonical form stays newline-only, `fmt` makes it deterministic, no JS-style "some with, some without".
- **Arenas** — `std/arena`: `Arena<T>` + generational `Handle<T>` for cyclic data (trees with parent pointers, doubly-linked lists, graphs, ECS). `alloc`/`get`/`set`/`free`/`valid`/`modify`; a freed handle bumps the generation, so a stale handle's `get` returns `None` and `valid` is `false` — use-after-free caught without a borrow checker.

## Concurrency

One model — green tasks — with a single OS-thread escape hatch. No async/await, no `Future` types, no function coloring:

- **Green tasks** are the default — `Task.spawn(f)` / `Promise<T>.run(f)`: stackful coroutines via ucontext, 64KB guarded stacks (10K+ concurrent), cooperative scheduling with `schedulerYield()` and fd-readiness waits (kqueue/epoll). `Promise`/`Channel`/`select`/`WaitGroup` all park the task, not the OS thread, and compose freely. Collect results with `.await()`; `Promise.all`/`Promise.race` for fan-out.
- **`Promise.blocking(f)`** is the one escape hatch to a real OS thread — for CPU-bound work or blocking FFI that would otherwise starve the single-threaded cooperative scheduler. Its captures must be `Send` (compiler-enforced); the result comes back through the same `await`. Shared state across parallel workers goes through channels or `AtomicI64`/`AtomicBool` (seq_cst). `@send`/`@sync` annotate user types wrapping unsafe internals. (Public `Thread`/`Mutex`/`RwLock`/`parallel` were removed 2026-07-10 — see [concurrency-simplification.md](concurrency-simplification.md).)

The key design point: the same blocking `stream.recv()` works in a task and on a `Promise.blocking` thread. I/O functions check `schedulerCurrent()` at runtime — in a green task they set non-blocking and yield on EAGAIN; on an OS thread they block. Exit semantics are Go's: when `main` returns the process exits and outstanding tasks are abandoned — wait explicitly (`join`, `WaitGroup`, `Promise`, channel) or `schedulerRunToCompletion()`. No manual event loop, no scheduler auto-drain.

### The same patterns elsewhere

Every row is shipped Milo (`std/runtime`, `std/sync`, `std/select`), not planned:

| Pattern | Milo | Go | Rust (tokio) | TypeScript |
|---|---|---|---|---|
| Spawn concurrent work | `Task.spawn(f)` | `go f()` | `tokio::spawn(async {…})` | — (single thread; `Worker` + messages) |
| Result-bearing task | `Promise<T>.run(f)` … `p.await()` | channel by hand | `JoinHandle` + `.await` | `new Promise` / `await p` |
| Offload blocking/CPU work | `Promise.blocking(f)` | `go f()` (runtime multiplexes) | `spawn_blocking` | `Worker` threads |
| Fan-out, wait for all | `Promise.all` / `WaitGroup` | `sync.WaitGroup` | `join!` / `JoinSet` | `Promise.all` |
| First of N wins | `Promise.race` / `Select` | `select {}` | `select!` | `Promise.race` |
| Wait on channels + fds + timers + signals at once | `Select` arms (incl. a `Promise` via `p.channel()`) | `select {}` (channels only; fds need goroutine shims) | `select!` (futures) | — |
| Timeout an operation | `sel.onTimeout(ms)` arm | `context.WithTimeout` | `tokio::time::timeout` | `AbortSignal.timeout` |
| Stream of values | `Channel<T>` + `for x in ch` | channel + `range` | `mpsc` + `Stream` | async iterators |
| Blocking call inside concurrent code | just call it — I/O parks the green task | just call it | **must not** — needs `.await` or `spawn_blocking` | **must not** — blocks the event loop |
| Function coloring | none | none | `async fn` is viral | `async` is viral |
| Data-race safety | compile time (`Send`-checked captures, no shared mutable state) | runtime detector; races compile fine | compile time (`Send`/`Sync`) | single-threaded by construction |
| Cancel in-flight work | explicit (cancel channel); a losing `Select` arm keeps running | explicit (`context` cancellation) | drop the future — built in | `AbortController` |

Two honest rows: cancellation is where Rust's future-as-data model genuinely earns its
complexity — Milo and Go both make you cancel explicitly. And Go matches Milo on
coloring/blocking ergonomics; Milo's edge over Go is the left half of this doc
(compile-time data-race safety, move semantics, no GC), not this table.

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

Milo's core decisions independently converge with the design Rust's original
designer wanted but lost — move-default, built-in containers, interior iteration,
green threads, second-class `&`, no lifetimes, local-only inference, simple
grammar, first-class errors, simplicity over zero-cost abstraction. The full
point-by-point scorecard, the deliberate divergences (traits over ML modules;
capturing closures; nominal over structural), and the decisions taken from that
review live in **[graydon-review.md](graydon-review.md)** — the single source, so
this file and that one can't drift.

One decision that split from his answer *and* from Rust-as-shipped: **integer
overflow.** He wanted auto-bignum (off-ethos — unpredictable allocation in a
safety lane); Rust traps in debug and wraps in release. The **decided** end state
for Milo is trap in *all* build modes (principle #1 — a wrapped value is a silent
footgun), with `--no-overflow-checks` and the explicit
`wrappingAdd`/`saturatingAdd`/`checkedAdd` methods as the opt-outs, and range
analysis deleting checks where it can prove them safe.

**Shipped status (as of 2026-07-22): not yet reached.** The runtime overflow trap
(`llvm.sadd.with.overflow` → abort) is gated behind `--debug`; `milo run`, the
default `build` (-O2), and `--release` currently **wrap silently** — i.e. today's
behavior is Rust-parity, not the decided default. Wrapping is memory-*safe* (defined,
no UB), so this is a policy gap, not a soundness hole, but the docs above describe the
target, not the current default. Closing it = ungating the check to all modes (with
range analysis so the release cost stays near zero). Div-by-zero and `INT_MIN / -1`
already trap in every mode; overflow is the remaining case. Tracked in
[memory-safety-vs-rust.md](memory-safety-vs-rust.md).

## Open Questions

- (none currently tracked here)

## Prior Art

- **Austral** — second-class references, linear types, minimal design
- **Vale** — generational references, region-based memory
- **Hylo** — mutable value semantics (formalized second-class refs academically)
- **Zig** — comptime, explicit allocators, C interop
- **Elm** — error messages as a design priority
- **Lobster** — compile-time lifetime analysis without annotations
