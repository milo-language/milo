# Milo

Rust's safety. Go's simplicity. C's speed. No lifetime annotations.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

## Why Milo

**Same safety as Rust, fraction of the learning curve.** Milo's entire ownership model is one rule: references can't escape the function they're passed to. That's it. No borrow checker fights, no lifetime annotations, no `where 'a: 'b`. The compiler tracks ownership, prevents use-after-free, and frees memory automatically.

**Faster than Go, within 5% of C.** Milo compiles to native code via LLVM. It beats C on 3 out of 9 benchmarks (binary trees, matrix multiply, startup time) and stays within 3-5% on the rest. Sub-millisecond startup. Binaries under 300KB.

**Concurrency without async/await.** Green threads give you Go-style concurrency without the runtime overhead. No `async` keyword, no `Future<T>`, no splitting your codebase into "async world" and "sync world." Write normal blocking code — when it runs in a green thread, I/O yields automatically.

```milo
from "std/runtime" import { greenSpawn, schedulerYield }

fn main(): i32 {
    greenSpawn(move (): void => { print("hello from green thread 1") })
    greenSpawn(move (): void => { print("hello from green thread 2") })
    return 0
}
```

**Five compile-time safety guarantees:**

| Safety | How |
|--------|-----|
| Memory | Move semantics, bounds-checked arrays, no dangling refs |
| Null | `Option<T>` — no null pointers in safe code |
| Races | `Send`/`Sync` traits — compiler rejects data races |
| Overflow | Compile-time range checks + debug-mode traps |
| Coercion | No implicit conversions — explicit `as` casts only |

## Where Milo fits

|  | GC | Lifetimes | Ownership | Native | No async/await |
|---|---|---|---|---|---|
| Go | yes | no | no | yes | no (goroutines yes) |
| Rust | no | yes | yes | yes | no |
| Zig | no | no | no | yes | no |
| **Milo** | **no** | **no** | **yes** | **yes** | **yes** |

## At a glance

- **273 tests** — fixtures, error cases, end-to-end
- **44 stdlib modules** — http, json, net, crypto, regex, threads, green threads, fs, process, and more
- **15 example apps** — web servers, CLI tools (grep, jq, hex, tree, calc)
- **Self-hosting** — stage-0 compiler written in Milo compiles Milo
- **LSP + VS Code** — diagnostics, hover, go-to-definition, completions
- **Package manager + formatter** — both written in Milo

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cs01/milo/main/install.sh | sh
```

Requires LLVM/Clang for linking.

```bash
milo run server.milo              # compile and run
milo build server.milo -o server  # compile to binary
milo test tests/                  # run tests
```

## From source

Requires: [Bun](https://bun.sh), LLVM/Clang.

```bash
bun run src/main.ts run examples/hello.milo
bun test
```

## Learn more

**[Language Guide](docs/language-guide.md)** — types, ownership, error handling, closures, concurrency, FFI, stdlib

**[Design Doc](docs/design.md)** — why Milo makes the tradeoffs it does

**[Roadmap](docs/roadmap.md)** — what's done, what's next
