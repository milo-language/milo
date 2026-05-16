# Learn Milo

Milo is a systems language that gives you memory safety through ownership — without garbage collection or lifetime annotations. It compiles to native code via LLVM and runs fast.

## What makes Milo different

**You own your memory.** Every value has a single owner. When the owner goes out of scope, memory is freed. The compiler tracks this for you — no manual `free()`, no GC pauses.

**No lifetime annotations.** References (`&T`) exist only in function parameters and local variables. They can't be stored in structs or returned from functions. This one restriction eliminates the hardest part of Rust.

**Familiar syntax.** `let`/`var` bindings, `: Type` annotations, `=>` arrow closures, `for-in` loops, generics with `<T>`. If you've used a modern language, you'll feel at home.

## A taste

```milo
fn main(): i32 {
    var items: Vec<string> = Vec.new()
    items.push("hello")
    items.push("world")

    let upper = items.map((s: &string) => s.toUpper())
    for s in upper {
        print(s)
    }

    return 0
}
```

Ownership, move semantics, and automatic cleanup — all happening behind familiar syntax.

## Key concepts

| Concept | What it means in Milo |
|---|---|
| **Ownership** | Every value has one owner. Assigning moves it — the original is gone. |
| **Borrowing** | `&T` lets functions read without taking ownership. `&mut T` lets them mutate. |
| **Move semantics** | Use-after-move is a compile error. No dangling pointers, ever. |
| **Enums** | Tagged unions with payloads — `Option<T>`, `Result<T, E>`, or your own. |
| **Pattern matching** | `match` with exhaustiveness checking. |
| **Traits** | Shared behavior across types. Think interfaces with default implementations. |
| **Zero-cost strings** | Owned `string` and borrowed `&string` slices — zero-copy when possible. |

## Learn step by step

Work through the guide in order. Each section builds on the last.

1. [Variables & Types](/language/variables) — `let`, `var`, primitives, type inference
2. [Functions](/language/functions) — parameters, return types, borrowing
3. [Structs](/language/structs) — custom types, methods, constructors
4. [Enums & Matching](/language/enums) — tagged unions, `match`, `Option<T>`
5. [Error Handling](/language/error-handling) — `Result<T, E>`, the `?` operator
6. [Ownership](/language/ownership) — moves, borrows, and why it all works
7. [Collections](/language/collections) — `Vec<T>`, `Map<K, V>`, iteration
8. [Strings](/language/strings) — owned vs. borrowed, slicing, UTF-8
9. [Traits](/language/traits) — interfaces, `Display`, generic constraints
10. [Closures](/language/closures) — arrow functions, captures, `.map`/`.filter`
11. [Warnings & Errors](/language/warnings-and-errors) — diagnostics, lints, `--deny`/`--allow`
12. [Modules](/language/modules) — imports, `std/` library, project structure
13. [C FFI](/language/ffi) — calling C from Milo

<div style="margin-top: 2rem;">

[Start with Variables & Types →](/language/variables)

</div>
