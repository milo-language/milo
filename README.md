# Milo

A small, memory-safe systems language that compiles to LLVM IR.

Values move by default. References are second-class — they can only appear as function parameters, so they cannot dangle. No garbage collector, no reference counting, no lifetime annotations, no `unsafe`.

The bet: restricting references to function parameters eliminates lifetimes entirely while preserving most of what borrows are good for. Cyclic and recursive data structures will be handled by generational-index arenas (planned, not yet implemented).

**[Language Guide →](docs/language-guide.md)** — full walkthrough with examples covering every feature.

## Quick Start

```bash
# compile to native binary
bun run src/main.ts build examples/hello.milo -o hello
./hello

# emit LLVM IR
bun run src/main.ts emit-ir examples/hello.milo

# run the test suite
bun test
```

Requires: [Bun](https://bun.sh), LLVM/Clang.

## Hello, Milo

```
fn main(): i32 {
    print("Hello, Milo!")
    return 0
}
```

C FFI when you need it:

```
extern fn puts(s: *u8): i32

fn main(): i32 {
    puts("via libc")
    return 0
}
```

## What Works Today

**Types**
- Primitives: `i8`–`i64`, `u8`–`u64`, `f32`, `f64`, `bool`
- Owned `String` (`{ptr, len, cap}`) with `+`, `==`, byte indexing, FFI coercion to `*u8`
- Structs (value types, move semantics)
- Bounds-checked arrays
- Enums / tagged unions with exhaustive `match`
- `Box<T>` — heap-allocated single-owner pointer, recursive enum payloads (linked lists, trees, ASTs)
- `Vec<T>` — dynamic arrays with `push`/`pop`/`len`, bounds-checked indexing
- `HashMap<K, V>` — open-addressing hash table with `insert`/`get`/`contains`/`remove`/`len`
- Drop semantics — heap-owning values auto-freed on scope exit
- Generics on functions, enums, and structs (monomorphization, type inference)

**Traits**
```
trait Eq {
    fn eq(self: &Self, other: &Self): bool
}

@derive(Eq)
struct Point { x: i32, y: i32 }

impl Point {
    fn manhattan(self: &Self): i32 { return self.x + self.y }
}

fn print_if_eq<T: Eq>(a: &T, b: &T) { ... }  // generic bounds
```
- `trait` declarations with required and default methods
- `impl Trait for Type` and inherent `impl Type` blocks
- Generic bounds `<T: Bound1 + Bound2>`, supertraits `trait Ord: Eq`
- `@derive(Eq)` auto-generates implementations
- `Self` type alias in trait/impl bodies
- Monomorphized static dispatch (zero-cost, no vtables)

**Closures**
```
fn apply(f: fn(i32): i32, x: i32): i32 { return f(x) }

let result = apply((x: i32) => x * 2, 21)    // expression closure
let inc = (x: i32) => x + 1                   // stored in local
var count: i32 = 0
call_it(() => { count = count + 1 })           // block closure, captures by reference
```
Non-escaping: closures can be passed as function params or stored in locals, but cannot be returned or stored in structs. Captures are by reference — mutations visible outside.

**Control flow**
- `if`/`else`, `while`, `break`, `continue`, `return`
- `match` with exhaustiveness checking
- `if let` for single-variant pattern matching

**Option / Result ergonomics**
```
let n: i64 = parse_int(s)!        // unwrap or panic with span
let n: i64 = parse_int(s)?        // propagate on error
let n: i64 = parse_int(s) ?? 0    // default on None/Err
```

**Modules**
```
import "math.milo"
from "std/http" import { Request, Response, serve }
```
Recursive resolution, dedup, transitive imports, selective `from ... import {}`.

**Standard Library**
- `std/http` — HTTP server with routing, response types (`Text`, `Html`, `Json`, `NotFound`, `Status`)
- `std/net` — TCP, DNS, HTTP client (`fetch`)
- `std/json` — view-based JSON parser, zero-allocation navigation
- `std/io` — file and directory I/O with automatic cleanup
- `std/mem` — memory management
- `std/args`, `std/argparse` — command-line argument parsing with typed getters and auto-generated help
- `std/process` — command execution and process control
- `std/os` — typed libc bindings
- `std/platform.{darwin,linux}` — platform-specific struct layouts and constants (auto-selected by host target)

**Diagnostics**
- Source spans on every AST node
- Elm-style errors with source context, carets, hints
- Type checker pass between parser and codegen — semantic errors caught before IR

**Tooling**
- LSP server (`milod`): diagnostics, hover, go-to-definition
- VS Code extension: syntax highlighting + LSP client
- GitHub Actions CI

158 tests pass on the current build.

## Design Principles

- `let` = immutable (maps to SSA register in LLVM IR)
- `var` = mutable (maps to alloca)
- No pointers in safe code
- No GC, no RC, no lifetimes, no `unsafe`
- Cost model visible in syntax — what you write is what LLVM sees

## Safety Mechanisms

1. **Move semantics** — single owner, assignment transfers ownership, use-after-move is a compile error
2. **Second-class references** — `&T` and `&mut T` may only appear as function parameters; cannot be returned, stored, or rebound
3. **Bounds-checked arrays** — out-of-bounds is a clear panic, not silent corruption

## What's Missing

Honest list of major gaps:

- **Traits Phase 1 only.** Nominal traits with monomorphized dispatch work. Missing: `dyn Trait`, associated types, operator overloading via traits, `where` clauses. Built-in types (Vec, HashMap, String) still use hardcoded methods rather than trait impls.
- **No arenas yet.** Planned answer for cyclic data and bulk-allocated graphs. `Box<T>` handles trees and recursive structures meanwhile.
- **No string `split`/`find`/`starts_with`.** `substr(start, end)` and slice sugar `s[a..b]` work, but richer string operations are missing.
- **Closures non-escaping only.** Cannot be returned or stored in structs, so no `map`/`filter` chains that outlive a single call frame.
- **No `guard let`.** `if let` works; `guard let ... else { return }` not yet.
- **No concurrency story.** Design open — leaning toward structured concurrency + channels, not async/await.
- **No formatter, no package manager, no REPL.**
- **Not self-hosting.** Compiler is ~8.4k lines of TypeScript. A stage-0 bootstrap (`milo0/`) written in Milo can compile basic programs end-to-end; stage-1 (structs, enums, match, Box, strings) is in progress.

See [docs/roadmap.md](docs/roadmap.md) for full status.

## Position

Use instead of C. Use instead of Rust when you do not need Rust's full power. Not "learn before Rust" — Milo is not a teaching language and lacks the pedagogical tooling that requires.

Nearest neighbors: [Hylo](https://www.hylo-lang.org/) (mutable value semantics, closest research lineage), [Vale](https://vale.dev/) (generational references), [Austral](https://austral-lang.org/) (linear types). Milo differs by combining second-class-only references, conventional syntax, and a small approachable compiler.

## Status

Phase 3 — language core in place. `Box<T>`, `Vec<T>`, `HashMap<K, V>`, non-escaping closures, traits (Phase 1), cross-platform stdlib, and a stage-0 self-hosting bootstrap shipped. Next: operator overloading via traits, arenas, stage-1 bootstrap (Vec/HashMap in milo0).
