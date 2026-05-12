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

### 2. Second-Class References

References (`&T`, `&mut T`) can ONLY appear as function parameters. They cannot be returned, stored in structs, or assigned to variables. Dangling references are impossible by construction — no lifetime annotations needed.

```
fn length(v: &Vec2) -> f64 {
    sqrt(v.x * v.x + v.y * v.y)
}

fn bad() -> &Vec2 {            // COMPILE ERROR: can't return a reference
    // ...
}

struct Bad {
    ref: &Vec2                  // COMPILE ERROR: can't store a reference
}
```

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
    Ok(v)  => println(v),
    Err(e) => println(e),
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
| Cyclic data | Easy (arenas) | Painful | Easy (unsafe) | Manual |
| Lifetime annotations | None | Required | N/A | None |
| Learning curve | Low (goal) | High | Medium then deadly | Medium |
| GC | No | No | No | No |

## Open Questions

- Trait/interface system or just structs + generics?
- Error handling: Result everywhere? try/catch sugar?
- String type: owned bytes? UTF-8 validated?
- FFI safety boundary: opaque handles? unsafe blocks?
- Module/import system

## Prior Art

- **Austral** — second-class references, linear types, minimal design
- **Vale** — generational references, region-based memory
- **Hylo** — value semantics, mutable value semantics
- **Zig** — comptime, explicit allocators, C interop
- **Elm** — error messages as a design priority
- **Lobster** — compile-time lifetime analysis without annotations
