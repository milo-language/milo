# Milo

A memory-safe systems language that compiles to native code via LLVM. Ownership without lifetimes.

```
fn main(): i32 {
    let name = "world"
    print("hello, ", name, "!")
    return 0
}
```

```bash
$ milo run hello.milo
hello, world!
```

## Why Milo?

|  | GC | Lifetimes | Ownership | Native |
|---|---|---|---|---|
| Go | yes | no | no | yes |
| Rust | no | yes | yes | yes |
| TypeScript | yes | no | no | no |
| **Milo** | **no** | **no** | **yes** | **yes** |

Native speed and memory safety without a garbage collector or lifetime annotations. Modern syntax. Binaries under 300KB with sub-millisecond startup.

## Learn by example

### Variables

`let` is immutable, `var` is mutable.

```
let x = 42          // can't reassign
var count = 0       // can reassign
count = count + 1
```

### Functions and structs

Type annotations go after the name, like TypeScript.

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
    print(greet(u))
    return 0
}
```

`&User` borrows without consuming — `u` is still usable after the call. Milo auto-borrows at call sites, so you write `greet(u)` not `greet(&u)`.

### Enums and pattern matching

Enums carry data. `match` is exhaustive — the compiler rejects unhandled cases.

```
enum Shape {
    Circle(f64),
    Rect(f64, f64),
}

fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r)  => 3.14159 * r * r
        Shape.Rect(w, h) => w * h
    }
}
```

### Error handling

Return `Result<T>` for fallible operations. Three ways to handle them:

```
fn readNumber(path: &string): Result<i64> {
    let text = readFile(path)?     // ? propagates errors to caller
    return text.trim().parseI64()
}

fn main(): i32 {
    let a = readNumber("count.txt") ?? 0   // ?? uses a default
    let b = readNumber("count.txt")!       // ! unwraps (panics on error)
    print(a + b)
    return 0
}
```

For typed errors, define an enum. `?` auto-wraps between compatible error types — no conversion boilerplate:

```
enum AppError {
    Io(IoError),       // ? auto-wraps IoError -> AppError.Io(e)
    Parse(ParseError), // ? auto-wraps ParseError -> AppError.Parse(e)
}

fn process(path: string): Result<i32, AppError> {
    let text = readFile(path)?        // IoError -> AppError, automatic
    let data = parseJson(text)?       // ParseError -> AppError, automatic
    return Result.Ok(data.len as i32)
}
```

### Ownership

Each value has one owner. Passing by value transfers ownership — the old name is dead.

```
var a = "hello"
let b = a       // ownership moves to b
print(a)        // compile error: a was moved
```

```
error: use of moved variable 'a'
  --> example.milo:3:7
  |
3 |     print(a)
  |           ^
  hint: ownership of 'a' was transferred earlier and it can no longer be used here.
        To keep it alive, clone it at the point of transfer: 'a.clone()'.
```

No runtime cost, no GC. The compiler catches it before the program runs.

References (`&T`) can only appear as function parameters — never stored in structs or returned. This single restriction eliminates lifetime annotations entirely while keeping memory safe.

### Collections

Vec, HashMap, and Box manage heap memory automatically — freed when they go out of scope.

```
var nums: Vec<i32> = Vec.new()
nums.push(1)
nums.push(2)
print("len: ", nums.len)   // 2

var ages: HashMap<string, i32> = HashMap.new()
ages.insert("alice", 30)
```

### Strings

Owned UTF-8 buffers with built-in methods — no imports needed.

```
let s = "Hello, World!"
print(s.toLower())           // "hello, world!"
print(s.contains("World"))    // true
print(s.split(", ")[0])       // "Hello"
print(s.replace("World", "Milo"))  // "Hello, Milo!"
```

### C FFI

Call any C library with `extern fn` and an `unsafe` block.

```
extern fn sqrt(x: f64): f64

fn main(): i32 {
    let root = unsafe { sqrt(2.0) }
    print("sqrt(2) = ", root)
    return 0
}
```

## Performance

Milo compiles via LLVM with `-O2` — same backend as C and Rust. On most workloads it lands within noise of C:

| Benchmark | C | Milo | Milo vs C |
|-----------|---|------|-----------|
| matmul 256x256 | 12.4ms | 11.8ms | 0.95x |
| binarytrees depth 15 | 2.5ms | 1.9ms | 0.76x |
| quicksort 500k f64 | 33.5ms | 34.5ms | 1.03x |

Full results: `./benchmarks/run.sh`

## Quick start

Requires: [Bun](https://bun.sh), LLVM/Clang.

```bash
bun run src/main.ts run examples/hello.milo        # compile and run
bun run src/main.ts build examples/hello.milo -o hello  # build a binary
bun test                                            # run tests
```

**VS Code** — syntax highlighting, diagnostics, hover, and go-to-definition:

```bash
cd editors/vscode && bun install && bun run build
ln -s "$(pwd)" ~/.vscode/extensions/milo.milo-lang-0.2.0
```

## Example programs

Milo ships real CLI tools and apps as examples — all compile to small native binaries.

**CLI Tools** (`examples/cli-tools/`)

| Program | Description |
|---------|-------------|
| [grep](examples/cli-tools/grep.milo) | Pattern search with `-i`, `-n`, `-c`, `-v` |
| [wc](examples/cli-tools/wc.milo) | Line/word/char counter |
| [hex](examples/cli-tools/hex.milo) | Hex dump viewer |
| [tree](examples/cli-tools/tree.milo) | Recursive directory listing |
| [cat](examples/cli-tools/cat.milo) | File viewer with syntax highlighting |
| [jq](examples/cli-tools/jq.milo) | JSON query tool |

**Apps** (`examples/apps/`)

| Program | Description |
|---------|-------------|
| [serve](examples/apps/serve.milo) | Static file server with directory listing |
| [http](examples/apps/http.milo) | HTTP client with JSON pretty-printing |
| [webserver](examples/apps/webserver.milo) | HTTP server with routing |
| [fetch](examples/apps/fetch.milo) | HTTP client with TLS |

## Standard library

| Module | Highlights |
|--------|-----------|
| `std/io` | `readFile`, file handles with RAII |
| `std/fs` | `readDir`, `file_info`, `pathExists` |
| `std/net` | TCP, DNS, `fetch` with TLS |
| `std/http` | HTTP server with routing |
| `std/json` | View-based JSON parser |
| `std/argparse` | CLI argument parsing with `--help` generation |
| `std/arena` | Generational arena for cyclic/graph data |
| `std/process` | Command execution, spawn/signal |

## What's next

- `for` loops and iterators
- Closures that escape (store in structs, return from functions)
- Trait objects (`dyn Trait`), operator overloading
- Structured concurrency + channels
- Package manager

See [docs/roadmap.md](docs/roadmap.md) for full status. **[Language Guide →](docs/language-guide.md)** for the complete walkthrough.
