# Milo

A memory-safe systems language that compiles to native code via LLVM. Ownership without lifetimes.

```rust
fn main(): i32 {
    let name = "world"
    print("hello, ", name, "!")
    return 0
}
```

```bash
$ bun run src/main.ts run hello.milo
hello, world!
```

## Where it fits

|  | GC | Lifetimes | Ownership | Native |
|---|---|---|---|---|
| Go | yes | no | no | yes |
| Rust | no | yes | yes | yes |
| TypeScript | yes | no | no | no |
| **Milo** | **no** | **no** | **yes** | **yes** |

Milo occupies the empty cell: native speed, memory safety, no GC, no lifetime annotations.

- **Second-class references** — `&T` only as function params; no lifetime annotations, ever
- **Move semantics** — single owner, use-after-move is a compile error
- **Exhaustive pattern matching** — `match` on enums/tagged unions, compiler enforces all cases
- **Typed error handling** — `Result<T, E>` with auto-conversion between error types via `?`; no `thiserror`/`anyhow` needed
- **Rich type system** — structs, enums, generics, traits, `Vec`, `HashMap`, `Box`, closures
- **TypeScript-like syntax** — `let`/`var`, type annotations after names, familiar string methods
- **Small binaries** — CLI tools compile to <300KB, sub-millisecond startup
- **LSP + VS Code** — diagnostics, hover, go-to-definition out of the box

## Performance

Milo compiles via LLVM with `-O2`, giving it access to the same backend optimizations as C and Rust. On most workloads it lands within noise of C:

| Benchmark | C | Milo | Go | Milo vs C |
|-----------|---|------|----|-----------|
| matmul 256x256 | 12.4ms | 11.8ms | 13.3ms | **0.95x** |
| binarytrees depth 15 | 2.5ms | 1.9ms | 9.7ms | **0.76x** |
| startup empty main | 1.4ms | 1.1ms | 1.8ms | **0.77x** |
| stringops 100k concat | 4.9ms | 4.8ms | 11.7ms | **0.97x** |
| sieve to 1M | 2.1ms | 2.2ms | 3.6ms | 1.04x |
| quicksort 500k f64 | 33.5ms | 34.5ms | 35.4ms | 1.03x |
| fib(35) | 17.7ms | 20.8ms | 22.5ms | 1.17x |
| maplookup 50k | 2.1ms | 2.7ms | 2.6ms | 1.28x |
| grep -c 1MB | 2.1ms | 4.7ms | 3.0ms | 2.18x |

Apple M-series, macOS. Slower entries (grep, maplookup) have known hot spots — not fundamental limits. Run `./benchmarks/run.sh` to reproduce.

## The language

### Enums and pattern matching

Enums carry data. `match` is exhaustive — the compiler rejects unhandled cases.

```
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Triangle(f64, f64, f64),
}

fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r)          => 3.14159 * r * r
        Shape.Rect(w, h)         => w * h
        Shape.Triangle(a, b, c)  => {
            let p = (a + b + c) / 2.0
            return (p * (p-a) * (p-b) * (p-c))
        }
    }
}
```

### Error handling

Functions return `Result<T>` for simple string errors, or `Result<T, E>` when callers need to branch on the error cause. Use `?` to propagate errors up the call stack, `!` to unwrap (panics on failure), or `??` to supply a default.

```
fn read_number(path: &string): Result<i64> {
    let text = read_file(path)?       // propagates Err on failure
    return text.trim().parse_i64()
}

// ?? — use a default, error silently dropped
fn main(): i32 {
    let n = read_number("count.txt") ?? 0
    print("count: ", n)
    return 0
}

// ! — unwrap, panics with the error message on failure
fn main(): i32 {
    let n = read_number("count.txt")!
    print("count: ", n)
    return 0
}

// ? — propagate up; main calls a fallible inner fn
fn run(): Result<i32> {
    let n = read_number("count.txt")?   // returns Err to caller on failure
    print("count: ", n)
    return Result.Ok(0)
}

fn main(): i32 {
    match run() {
        Result.Ok(code)  => { return code }
        Result.Err(msg)  => { print("error: ", msg); return 1 }
    }
}
```

**Typed errors** — when you need to branch on the cause, use a custom error enum:

```
enum IoError {
    NotFound(string),
    PermissionDenied(string),
}

fn read_file(path: string): Result<string, IoError> { ... }

// branch on cause
match read_file("config.toml") {
    Result.Ok(data)                    => { parse(data) }
    Result.Err(IoError.NotFound(_))    => { use_defaults() }
    Result.Err(IoError.PermissionDenied(p)) => { print("denied: ", p) }
}
```

**Cross-error-type propagation** — `?` auto-wraps errors when the caller's error enum has a matching variant. No manual conversion, no traits to implement:

```
enum AppError {
    Io(IoError),         // ? auto-wraps IoError → AppError.Io(e)
    Parse(ParseError),   // ? auto-wraps ParseError → AppError.Parse(e)
}

fn process(path: string): Result<i32, AppError> {
    let text = read_file(path)?       // IoError auto-converts to AppError
    let data = parse_json(text)?      // ParseError auto-converts to AppError
    return Result.Ok(data.len as i32)
}
```

In Rust, this requires the `thiserror` crate for `#[derive(Error)]` + `#[from]`, or hand-writing `impl From<IoError> for AppError`. In Milo, the compiler sees that `AppError` has an `Io(IoError)` variant and generates the conversion automatically. No macros, no crate choices, no blog posts about which error library to pick.

### Ownership and borrowing

Each value has one owner. When a function takes `&T`, it borrows without consuming. Milo auto-borrows at call sites — you pass `u`, not `&u`.

```
struct User {
    name: string,
    age: i32,
}

fn greet(user: &User): string {
    return "hi, " + user.name
}

fn main(): i32 {
    let u = User { name: "Alice", age: 30 }
    print(greet(u))        // auto-borrows u for the &User param
    print("age: ", u.age)  // u is still valid
    return 0
}
```

### C FFI

Call any C library with `extern fn`. Requires an `unsafe` block at the call site.

```
extern fn sqrt(x: f64): f64
extern fn getenv(name: *u8): *u8

fn main(): i32 {
    let root = unsafe { sqrt(2.0) }
    print("sqrt(2) = ", root)
    return 0
}
```

## How memory safety works

### Second-class references

Rust's borrow checker is powerful but complex because references can escape — into structs, return values, nested closures — and the compiler must track all of it with lifetime annotations. Milo sidesteps this entirely: **references are second-class**. `&T` can only appear as function parameters, never stored or returned.

Here's the same `Parser` struct in Rust and Milo:

```rust
// Rust — storing a reference requires lifetime annotations everywhere it touches
struct Token<'a> { text: &'a str }

struct Parser<'a> {
    input: &'a str,
    current: Option<Token<'a>>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Token<'a>> { self.current.as_ref() }
}
```

```
// Milo — struct owns its data, no annotations at any depth
struct Token { text: string }

struct Parser {
    input: string,
    current: Option<Token>,
}

fn peek(p: &Parser): Option<Token> { return p.current }
```

In Milo, you can't store a reference in a struct — so you own the data instead. That restriction *is* the borrow checker. The deeper you nest in Rust (`'a` propagates into every containing struct and `impl`), the worse it gets. In Milo it stays flat.

The cost: Rust can pass references around freely — store them, return them, nest them. Milo's references are second-class: valid only as function parameters. When you need data to outlive a call, you own it. You either give up your original (a move) or explicitly duplicate it (`clone()`). No implicit sharing — the cost is always spelled out in code.

**Isn't that too restrictive?** In practice, the overwhelming majority of references are just function arguments — "give me this value briefly, I won't keep it." The cases where you'd want to store a reference (iterators, self-referential structs) are real but rare, and Milo handles them differently: owned data, `Vec` indices, or generational arenas (`std/arena`). The tradeoff is a much simpler mental model and zero annotation overhead for the 95% case. (For a deeper treatment of this design space, see Fernando Borretti's [Second-Class References](https://borretti.me/article/second-class-references).)

### Move semantics

Each value has exactly one owner. Passing a value by value transfers ownership — the old name is dead.

```
fn main(): i32 {
    var a = "hello"
    let b = a          // ownership moves to b
    print(a)           // ← compile error: a was moved
    return 0
}
```

```
error: use of moved variable 'a'
  ──> example.milo:4:11
  │
4 │     print(a)
  │           ^
  hint: ownership of 'a' was transferred earlier and it can no longer be used here.
        To keep it alive, clone it at the point of transfer: 'a.clone()'.
```

No runtime cost. The compiler rejects the program before it ever runs.

### Real programs

Milo ships with CLI tools that compile to <300KB native binaries with sub-millisecond startup. String methods work like TypeScript — `s.contains()`, `s.split()`, `s.trim()`, `s.to_lower()`, `s.replace()` — no imports needed.

```
// grep.milo
import "std/argparse"
import "std/io"

fn main(): i32 {
    var parser = new_parser("grep", "search for a string pattern in files")
    parser.add_positional("pattern", "string pattern to search for")
    parser.add_positional("file", "file to search")
    parser.add_bool("ignore-case", "i", "case-insensitive search")
    parser.add_bool("line-number", "n", "show line numbers")
    parser.add_bool("count", "c", "only print count of matching lines")
    let args = parser.parse()

    let pattern = args.get_string("pattern")
    let file_path = args.get_string("file")

    let content = read_file(file_path)!
    let lines = content.split("\n")

    var line_num: i64 = 0
    while line_num < lines.len {
        let line = lines[line_num]
        if line.contains(pattern) {
            print(line)
        }
        line_num = line_num + 1
    }
    return 0
}
```

### Heap types

Values own their heap memory and release it automatically when they go out of scope — no GC pauses, no `free()`, no `defer`.

```
fn main(): i32 {
    // Vec — dynamic array, auto-freed on scope exit
    var nums: Vec<i32> = Vec.new()
    nums.push(1)
    nums.push(2)
    nums.push(3)
    print("len: ", nums.len)        // 3

    // HashMap — same deal
    var ages: HashMap<string, i32> = HashMap.new()
    ages.insert("alice", 30)
    match ages.get("alice") {
        Option.Some(age) => print("alice is ", age)
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

For cyclic data (graphs, doubly-linked lists), use `std/arena`. Nodes reference each other via `Handle<T>` — typed indices into the arena — instead of pointers, which keeps the ownership model intact:

```
import "std/arena"

struct DLNode {
    value: i64,
    prev: Option<Handle<DLNode>>,
    next: Option<Handle<DLNode>>,
}

fn main(): i32 {
    var arena: Arena<DLNode> = arena_new()
    let a = arena_alloc(arena, DLNode { value: 1, prev: Option.None, next: Option.None })
    let b = arena_alloc(arena, DLNode { value: 2, prev: Option.Some(a), next: Option.None })
    arena_modify(arena, a, (n: DLNode) => {
        var updated = n
        updated.next = Option.Some(b)
        return updated
    })
    return 0
}
```

## Quick Start

Requires: [Bun](https://bun.sh), LLVM/Clang.

```bash
bun run src/main.ts run examples/hello.milo        # compile and run in one step

bun run src/main.ts build examples/hello.milo -o hello && ./hello  # build a binary
bun run src/main.ts emit-ir examples/hello.milo    # see the LLVM IR
bun test
```

**VS Code** — syntax highlighting, diagnostics, hover, and go-to-definition via the bundled LSP:

```bash
cd editors/vscode && bun install && bun run build
ln -s "$(pwd)" ~/.vscode/extensions/milo.milo-lang-0.2.0
```

Restart VS Code and open any `.milo` file.

**[Language Guide →](docs/language-guide.md)** — full walkthrough of every feature.

## Example Programs

**CLI Tools** (`examples/cli-tools/`)

| Program | Description |
|---------|-------------|
| [grep](examples/cli-tools/grep.milo) | Pattern search with color highlighting, `-i`, `-n`, `-c`, `-v` |
| [wc](examples/cli-tools/wc.milo) | Line/word/char counter |
| [hex](examples/cli-tools/hex.milo) | Hex dump viewer with ASCII column |
| [tree](examples/cli-tools/tree.milo) | Recursive directory tree with depth limiting |
| [cat](examples/cli-tools/cat.milo) | File viewer with syntax highlighting |
| [jq](examples/cli-tools/jq.milo) | JSON query tool (field access, array iteration) |

**Apps** (`examples/apps/`)

| Program | Description |
|---------|-------------|
| [serve](examples/apps/serve.milo) | Static file server with directory listing |
| [http](examples/apps/http.milo) | HTTP client with JSON pretty-printing |
| [webserver](examples/apps/webserver.milo) | HTTP server with routing |
| [fetch](examples/apps/fetch.milo) | HTTP client with TLS |

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

## What's Missing

- **Traits Phase 1 only.** No `dyn Trait`, associated types, operator overloading, `where` clauses
- **Closures non-escaping.** Can't be returned or stored in structs
- **No `for` loops.** `while` only for now
- **No concurrency.** Design open — leaning toward structured concurrency + channels
- **No formatter, package manager, or REPL**

See [docs/roadmap.md](docs/roadmap.md) for full status.
