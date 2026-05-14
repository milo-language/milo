# Milo

A memory-safe systems language that compiles to native code via LLVM. Ownership without lifetimes.

```
fn main(): i32 {
    let name = "world"
    print("hello, %s!", name)
    return 0
}
```

```bash
$ milo build hello.milo -o hello && ./hello
hello, world!
```

## Why Milo?

**Rust's safety, TypeScript's readability, no compromises.**

Milo proves you don't need lifetime annotations to get memory safety. The trick: references are second-class — `&T` can only appear as function parameters, never stored or returned. This single rule eliminates the entire borrow checker while keeping use-after-free, double-free, and dangling pointer bugs impossible.

### The compiler catches use-after-free

```
fn main(): i32 {
    var a = "hello"
    let b = a          // ownership moves to b
    print("%s", a)     // ← compile error: use of moved value 'a'
    return 0
}
```

```
error: use of moved value 'a'
  ──> example.milo:4:20
   │
 4 │     print("%s", a)
   │                 ^
   │
   = 'a' was moved on line 3
```

No runtime cost. No garbage collector. The compiler rejects the program before it ever runs.

### References can't escape

```
fn first_byte(s: &string): u8 {   // borrow for the duration of the call
    return s[0]
}

fn main(): i32 {
    let s = "hello"
    let b = first_byte(s)          // s is borrowed, not moved
    print("%d %s", b, s)           // s is still valid
    return 0
}
```

References (`&T`) exist only as function parameters. You can't store them in structs, return them, or put them in a `Vec`. This means dangling references are structurally impossible — no lifetime annotations needed, ever.

### Compare to Rust

The same program in Rust requires you to think about lifetimes:

```rust
// Rust — this works, but add a struct that holds &str
// and suddenly you need lifetime annotations everywhere
fn first_byte(s: &str) -> u8 {
    s.as_bytes()[0]
}
```

In Milo, there's nothing to annotate. The rule is simple: references go in, but they don't come out.

### Real programs, not toy examples

Milo ships with CLI tools that compile to <300KB native binaries with sub-millisecond startup:

```
// grep.milo — 80 lines, full featured
import "std/argparse"
import "std/io"

fn main(): i32 {
    var parser = new_parser("grep", "search for a string pattern in files")
    parser.add_bool("ignore-case", "i", "case-insensitive search")
    parser.add_bool("line-number", "n", "show line numbers")
    parser.add_bool("count", "c", "only print count of matching lines")
    let args = parser.parse()

    let pattern = args.positional[0].clone()
    let file_path = args.positional[1].clone()

    let content = read_file(file_path)!
    let lines = content.split("\n")

    var line_num: i64 = 0
    while line_num < lines.len {
        let line = lines[line_num]
        if line.contains(pattern) {
            print("%s", line)
        }
        line_num = line_num + 1
    }
    return 0
}
```

String methods work like TypeScript — `s.contains()`, `s.split()`, `s.trim()`, `s.to_lower()`, `s.replace()` — no imports needed.

### Ownership is simple

```
struct User {
    name: string,
    age: i32,
}

fn greet(user: &User): string {     // borrow — doesn't consume
    return "hi, " + user.name
}

fn main(): i32 {
    let u = User { name: "Alice", age: 30 }
    print("%s", greet(u))           // auto-borrow for &User param
    print("age: %d", u.age)        // u is still valid
    return 0
}
```

One rule: each value has one owner. When ownership transfers (`let b = a`), the old name is dead. When a function takes `&T`, it borrows without taking ownership. That's the entire model.

### Heap types just work

```
fn main(): i32 {
    // Vec — dynamic array, auto-freed on scope exit
    var nums: Vec<i32> = Vec.new()
    nums.push(1)
    nums.push(2)
    nums.push(3)
    print("len: %lld", nums.len)    // 3

    // HashMap — same deal
    var ages: HashMap<string, i32> = HashMap.new()
    ages.insert("alice", 30)
    match ages.get("alice") {
        Option.Some(age) => print("alice is %d", age)
        Option.None => print("not found")
    }

    // Box — single-owner heap pointer for recursive types
    enum Tree {
        Leaf(i32),
        Node(Box<Tree>, Box<Tree>),
    }
    let t = Tree.Node(Box.new(Tree.Leaf(1)), Box.new(Tree.Leaf(2)))

    return 0
}   // nums, ages, t — all freed here, no leaks
```

No `free()`, no `defer`, no GC. Drop semantics clean up heap memory when values go out of scope.

## Quick Start

```bash
bun run src/main.ts build examples/hello.milo -o hello
./hello

bun run src/main.ts emit-ir examples/hello.milo   # see the LLVM IR
bun test                                            # 163 tests
```

Requires: [Bun](https://bun.sh), LLVM/Clang.

**[Language Guide →](docs/language-guide.md)** — full walkthrough of every feature.

## Example Programs

| Program | Description | Lines |
|---------|-------------|-------|
| [grep](examples/grep.milo) | Pattern search with `-i`, `-n`, `-c`, `-v` flags | 80 |
| [wc](examples/wc.milo) | Line/word/char counter | 85 |
| [hex](examples/hex.milo) | Hex dump viewer with ASCII column | 100 |
| [tree](examples/tree.milo) | Recursive directory tree with depth limiting | 95 |
| [webserver](examples/webserver.milo) | HTTP server with routing | 236 |
| [json_parser](examples/json_parser.milo) | Full JSON parser into a value tree | 200 |
| [fetch](examples/fetch.milo) | HTTP client with TLS | 40 |

## What Works Today

**Types** — `i8`–`i64`, `u8`–`u64`, `f32`, `f64`, `bool`, owned strings, structs, enums/tagged unions, `Box<T>`, `Vec<T>`, `HashMap<K,V>`, fixed-size arrays, generics (monomorphization)

**Traits** — `trait` + `impl`, generic bounds (`<T: Eq + Hash>`), supertraits, `@derive(Eq)`, default methods, `Self` alias

**Closures** — Non-escaping, captures by reference, block and expression forms

**Control flow** — `if`/`else`, `while`, `break`/`continue`, `match` (exhaustive), `if let`

**Ergonomics** — `!` unwrap, `?` propagate, `??` default, move semantics, auto-borrow for `&T` params

**Standard Library**
| Module | What it does |
|--------|-------------|
| `std/string` | `contains`, `split`, `trim`, `index_of`, `replace`, `starts_with`, `ends_with`, `to_lower`/`to_upper`, `repeat` — all as built-in methods |
| `std/io` | `read_file`, `read_stdin`, `open_read`/`open_write`/`open_append`, `read_all`, `write_all`, RAII file handles |
| `std/fs` | `read_dir`, `file_info`, `is_dir`/`is_file`, `path_exists`, `write_file` |
| `std/path` | `path_join`, `path_basename`, `path_dirname`, `path_ext`, `path_stem` |
| `std/env` | `get_env`, `get_env_or` |
| `std/http` | HTTP server with routing, response types |
| `std/net` | TCP, DNS, `fetch` with TLS |
| `std/json` | View-based JSON parser |
| `std/argparse` | CLI argument parsing with typed getters and `--help` generation |
| `std/arena` | Generational arena for cyclic/graph data with safe handles |
| `std/process` | Command execution, `spawn`/`wait_for`/`signal` |

**Tooling** — LSP server (diagnostics, hover, go-to-def), VS Code extension, Elm-style error messages

## Position

|  | GC | Lifetimes | Ownership | Native |
|---|---|---|---|---|
| Go | yes | no | no | yes |
| Rust | no | yes | yes | yes |
| TypeScript | yes | no | no | no |
| **Milo** | **no** | **no** | **yes** | **yes** |

Nearest neighbors: [Hylo](https://www.hylo-lang.org/) (mutable value semantics), [Vale](https://vale.dev/) (generational references), [Austral](https://austral-lang.org/) (linear types). Milo differs by combining second-class-only references with familiar TS-like syntax and a small compiler.

## Design

- `let` = immutable (SSA register), `var` = mutable (alloca)
- Move semantics — single owner, use-after-move is a compile error
- Second-class references — `&T` only in function params, never stored or returned
- Bounds-checked arrays — out-of-bounds is a clear panic
- Drop semantics — heap values auto-freed on scope exit
- No GC, no RC, no lifetimes, no `unsafe` needed for safe code
- C FFI with `extern fn` when you need it

## What's Missing

- **Traits Phase 1 only.** No `dyn Trait`, associated types, operator overloading, `where` clauses
- **Closures non-escaping.** Can't be returned or stored in structs
- **No `for` loops.** `while` only for now
- **No concurrency.** Design open — leaning toward structured concurrency + channels
- **No formatter, package manager, or REPL**
- **Not self-hosting.** Compiler is ~8.4k lines of TypeScript. Stage-0 bootstrap in progress

See [docs/roadmap.md](docs/roadmap.md) for full status.
