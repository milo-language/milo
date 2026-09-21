# Milo

**A memory-safe systems language with second-class references: no lifetimes, no GC, one owner per value.**

`&T` and `&mut T` are parameters only. You cannot return a reference, store one in a struct, or keep one past the call. That is the whole language bet, and everything below follows from it.

[Docs](https://milo-language.github.io/milo/) · [Tour](https://milo-language.github.io/milo/tour) · [Playground](https://milo-language.github.io/milo/playground) · [Stdlib](https://milo-language.github.io/milo/stdlib/)

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => Response.Html("hello from milo"))!
    return 0
}
```

Compiles through LLVM to a static binary.

```sh
curl -fsSL https://milo-language.github.io/milo/install.sh | sh
milo run examples/hello.milo
```

## The rule

When you hand a value to someone else, you don't have it anymore. A borrow is a temporary look during one call. After the call, the owner is the only name that still exists.

A type that means "I point into memory I do not own" is not expressible. You own the buffer and carry an index, a `Span`, or an arena handle, or you `clone()`.

## Local reasoning

This is the property the rule buys, and the reason the rule is worth its cost.

**The function you are reading is the whole story of the values it touches.** Nothing outside the function holds a pointer into its locals, because no such pointer can exist. Every way a value can change or escape is written in the function body, at the call site:

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

Reading `main`, you know `v` changes inside `zeroNegatives` and nowhere else, because that is the only call that takes `&mut v`. `&mut x` at a call site is the full blast radius of a mutation. There is no other pointer to `v`, so there is nothing else to check.

The same holds for every other effect. Each one is declared where it happens, in the function you are looking at:

- `&mut x` at the call: this call may change `x`.
- `@unsafe`: this block talks to C or raw memory.
- `@thread`, `@parks`: this function starts an OS thread, or may yield a green task.
- `@mustUse`: this result cannot be dropped silently.
- `requires` / `ensures`: this function's contract, checked by `milo prove`.

The ownership checker's questions are settled inside one function. It never has to consult a lifetime on a signature three modules away, and neither do you.

## In C, in Rust, in Milo

| What you want | C | Rust | Milo |
|---|---|---|---|
| Return a pointer into a buffer you still hold | `char *`, you promise it stays valid | `fn longest(...) -> &'a str` | Not expressible. Return an index, a `Span`, or an owned string. |
| A parser that keeps the input | `struct Parser { char *src; }` | `struct Parser<'a> { src: &'a str }` | Not expressible. Own the input; store a cursor (`pos: i64`). |
| Iterator over a collection | pointer into the array | `Iterator<Item = &T>` | Not a stored borrow. A cursor is a position; each step takes the store: `scanNext(&store, &mut cursor)`. |
| Graph, parent pointer, DOM | `Node *next` | `Rc<RefCell<Node>>` or an arena crate | `std/arena`: `Arena<T>` plus `Handle<T>`. Lookup is checked at runtime. |
| Temporary read in a call | pointer argument | `&T` | `&T`, auto-borrowed at the call. Same idea. |
| Temporary mutation in a call | pointer argument | `&mut T` | `&mut T`, written at the call site: `f(&mut x)`. |
| Two owners of one buffer | two pointers, good luck | lifetimes, or `clone` / `Arc` | `.clone()`, or `seal` the buffer and share a read-only copy. |

Same memory-safety rows as Rust wherever both languages can say the program: use-after-move, use-after-free of owned data, no null. The rows Rust wins are one trade made twice: a view tied to its buffer is a compile error there and a named runtime check or a copy here. Nothing falls back to `unsafe` because the ownership model said no.

## What this is for

Programs that already look like "own a buffer, walk it with an index, mutate in place, return owned values":

- CLIs, HTTP services, tools
- compilers, emulators, engines with pools and arenas
- anything you would write in careful C as arena plus integer id

Not the default if your data model is an object graph of pointers, a zero-copy token stream stored in a vec, or "this object points at that object". Those programs can be rewritten. They will not look like the program you had in TypeScript or in fluent Rust.

## What you get

- **Local reasoning.** The section above. A function's body is its complete aliasing and effect story.
- **No lifetime annotations.** A borrow lives for one call. There is nothing to name and nothing to propagate through types.
- **No GC and no reference counting.** `let` / `var`, `for`, in-place mutation through `&mut`.
- **Concurrency without `Send` / `Sync`.** A value that cannot hold a borrow can move to another task as is. The compiler checks the two doors OS threads start at and rejects a view into a global held across a park.
- **Contracts in the language.** `requires` / `ensures`, checked for every input by `milo prove`.

## What you give up

- **Returning or storing a view.** Index, `Span`, owned copy, or arena handle instead.
- **Some zero-copy.** A copy you can see is the substitute for state you cannot see. Where Rust hands out a borrow, Milo sometimes asks for a `clone()`.
- **One check moves to runtime.** "This offset still belongs to that buffer" is a named runtime failure, not a compile error and not a segfault.

## Read more

- [Language tour](https://milo-language.github.io/milo/tour), runs in the browser
- [Why there are no lifetimes](https://milo-language.github.io/milo/language/why-no-lifetimes), with the census of five Rust codebases
- [Memory safety vs Rust](https://milo-language.github.io/milo/language/vs-rust)
- [`std/arena`](https://milo-language.github.io/milo/stdlib/arena)

## Status

Young, but dogfooded. More than 250k lines of Milo across a port of the compiler, a JS engine, three emulator cores, a debugger, and a dozen packages. Nearly every `unsafe` block is the C boundary. None exist because the ownership model rejected the program ([memory safety vs Rust](docs/memory-safety-vs-rust.md)).
