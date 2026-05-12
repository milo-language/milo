# Milo

A small, memory-safe systems language that compiles to LLVM IR.

Values move by default. References are second-class — they can only appear as function parameters, so they cannot dangle. No garbage collector, no reference counting, no lifetime annotations, no `unsafe`.

The bet: restricting references to function parameters eliminates lifetimes entirely while preserving most of what borrows are good for. Cyclic and recursive data structures will be handled by generational-index arenas (planned, not yet implemented).

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
fn main() -> i32 {
    println("Hello, Milo!")
    return 0
}
```

C FFI when you need it:

```
extern fn puts(s: *u8) -> i32

fn main() -> i32 {
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
- `Vec<T>` dynamic arrays with push/pop/len, bounds-checked indexing
- Generics on functions, enums, and structs (monomorphization, type inference)

**Control flow**
- `if`/`else`, `while`, `break`, `continue`, `return`
- `match` with exhaustiveness checking

**Option / Result ergonomics**
```
let n: i64 = parse_int(s)!        // unwrap or panic with span
let n: i64 = parse_int(s)?        // propagate on error
let n: i64 = parse_int(s) ?? 0    // default on None/Err
```

**Modules**
```
import "math.milo"
```
Recursive resolution, dedup, transitive imports.

**Diagnostics**
- Source spans on every AST node
- Elm-style errors with source context, carets, hints
- Type checker pass between parser and codegen — semantic errors caught before IR

**Tooling**
- LSP server (`milod`): diagnostics, hover, go-to-definition
- VS Code extension: syntax highlighting + LSP client

90 tests pass on the current build.

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

- **No hash maps or arenas.** `Box<T>` works for recursive types; `Vec<T>` provides dynamic arrays. Key-value stores not yet.
- **No arenas yet.** The arena design is the planned answer for cyclic data; Box<T> handles trees and recursive structures today.
- **No `if let` / `guard let`.** `!` `?` `??` cover most Option/Result cases; full sugar pending.
- **No formatter, no package manager, no REPL.**
- **Not self-hosting.** Compiler is ~4k lines of TypeScript.

See [docs/roadmap.md](docs/roadmap.md) for full status.

## Position

Use instead of C. Use instead of Rust when you do not need Rust's full power. Not "learn before Rust" — Milo is not a teaching language and lacks the pedagogical tooling that requires.

Nearest neighbors: [Hylo](https://www.hylo-lang.org/) (mutable value semantics, closest research lineage), [Vale](https://vale.dev/) (generational references), [Austral](https://austral-lang.org/) (linear types). Milo differs by combining second-class-only references, conventional syntax, and a small approachable compiler.

## Status

Phase 2 — most language features in place, heap and arenas next.
