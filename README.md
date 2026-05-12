# Milo

A minimal, memory-safe systems language that compiles to LLVM IR.

Values move by default, references are second-class (function params only), and recursive data structures use arenas with typed generational indices. The language where graphs and trees just work — without lifetimes, without a garbage collector, and without unsafe.

## Quick Start

```bash
# emit LLVM IR
bun run src/main.ts emit-ir examples/hello.milo

# compile to native binary
bun run src/main.ts build examples/hello.milo -o hello
./hello
```

Requires: [Bun](https://bun.sh), LLVM/Clang

## Example

```
extern fn puts(s: *u8) -> i32

fn main() -> i32 {
    puts("Hello, Milo!")
    return 0
}
```

## Design Principles

- `let` = immutable (maps to SSA register in LLVM IR)
- `var` = mutable (maps to alloca in LLVM IR)
- No pointers in safe code
- No garbage collector, no reference counting
- Cost model is visible — syntax tells you what LLVM will do

## Safety Mechanisms

1. **Move semantics** — values have a single owner, assignment transfers ownership
2. **Second-class references** — `&T` and `&mut T` can only appear as function parameters (no dangling refs by construction)
3. **Bounds-checked arrays** — out-of-bounds = panic, not corruption

## Status

Phase 1 — minimal viable language. See [docs/roadmap.md](docs/roadmap.md) for the full plan.
