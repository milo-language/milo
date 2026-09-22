# Milo

**A memory-safe systems language with second-class references: no lifetimes, no GC, one owner per value.**

[Docs](https://milo-language.github.io/milo/) · [Tour](https://milo-language.github.io/milo/tour) · [Stdlib](https://milo-language.github.io/milo/stdlib/)

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r = Router.new()
    r.get("/", (c: &mut Context) => Response.Html("hello from milo"))
    r.get("/users/:id", (c: &mut Context) => Response.Text($"user {c.param("id")!}"))
    serveRouter(8080, r)!
    return 0
}
```

Compiles through LLVM to a static binary.

```sh
curl -fsSL https://milo-language.github.io/milo/install.sh | sh
milo run examples/hello.milo
```

## The rule

`&T` and `&mut T` are parameters only. You cannot return a reference, store one in a struct, or keep one past the call. A type that means "I point into memory I do not own" is not expressible: you own the buffer and carry an index, a `Span`, or an arena handle, or you `clone()`.

What that buys is **local reasoning**: the function you are reading is the whole story of the values it touches. No pointer into its locals can exist anywhere else, so every mutation is visible at the call site.

```milo
fn zeroNegatives(values: &mut Vec<i64>): void {
    for i in 0..values.len {
        if values[i] < 0 {
            values[i] = 0       // in place, no copy, no allocation
        }
    }
}

fn main(): void {
    var v: Vec<i64> = [3, -1, 4, -5, 9]
    zeroNegatives(&mut v)      // the only line that can change v
    print(v)                   // [3, 0, 4, 0, 9]
}
```

The ownership checker settles everything inside one function. It never consults a lifetime on a signature three modules away, and neither do you.

## In C, in Rust, in Milo

| What you want | C | Rust | Milo |
|---|---|---|---|
| Return a pointer into a buffer you still hold | `char *`, you promise it stays valid | `fn longest(...) -> &'a str` | Not expressible. Return an index, a `Span`, or an owned string. |
| A parser that keeps the input | `struct Parser { char *src; }` | `struct Parser<'a> { src: &'a str }` | Own the input; store a cursor (`pos: i64`). |
| Iterator over a collection | pointer into the array | `Iterator<Item = &T>` | A cursor; each step takes the store: `scanNext(&store, &mut cursor)`. |
| Graph, parent pointer, DOM | `Node *next` | `Rc<RefCell<Node>>` or an arena crate | `std/arena`: `Arena<T>` plus `Handle<T>`, checked at runtime. |
| Temporary read / mutation in a call | pointer argument | `&T` / `&mut T` | `&T` auto-borrowed; `&mut T` written at the call: `f(&mut x)`. |
| Two owners of one buffer | two pointers, good luck | lifetimes, or `clone` / `Arc` | `.clone()`, or `seal` it and share a read-only copy. |

Same memory-safety guarantees as Rust wherever both languages can express the program. Also in the language: `requires` / `ensures` contracts checked by `milo prove`, and concurrency without `Send` / `Sync` (a value that cannot hold a borrow moves to another task as is).

## What you give up

- **Returning or storing a view.** Use an index, `Span`, owned copy, or arena handle.
- **Some zero-copy.** Where Rust hands out a borrow, Milo sometimes asks for a `clone()`.
- **One check moves to runtime.** "This offset still belongs to that buffer" is a named runtime failure, not a compile error and not a segfault.

Good fit: CLIs, services, compilers, emulators, anything you would write in careful C as a buffer plus integer ids. Awkward fit: code that wants to keep an object graph as is (widget trees with parent pointers, intrusive lists, parsers that store slices of their input). Those become arenas and handles, and won't look like the original ([what that looks like](https://milo-language.github.io/milo/language/patterns#build-a-tree-or-graph-whose-nodes-refer-to-each-other)).

## Status

Young, but dogfooded: 250k+ lines of Milo across a port of the compiler, a JS engine, three emulator cores, a debugger, and a dozen packages. Nearly every `unsafe` block is the C boundary; none exist because the ownership model rejected the program.

More: [why there are no lifetimes](https://milo-language.github.io/milo/language/why-no-lifetimes) · [memory safety vs Rust](https://milo-language.github.io/milo/language/vs-rust) · [`std/arena`](https://milo-language.github.io/milo/stdlib/arena)
