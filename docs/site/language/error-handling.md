# Error Handling

Milo has no exceptions and no null. If a function can fail, its return type says so, and the compiler won't let you ignore it.

## Result basics

Fallible functions return `Result<T, E>`: either `Result.Ok(value)` or `Result.Err(error)`.

```milo
from "std/fs" import { readFile }
from "std/io" import { IoError }
from "std/strconv" import { parseInt }

fn readNumber(path: &string): Result<i64, IoError> {
    let text = readFile(path)?
    match parseInt(text.trim()) {
        Option.Some(n) => { return Result.Ok(n) }
        Option.None => { return Result.Err(IoError.Other("not a number")) }
    }
}
```

`Ok(n)` and `Err(e)` may be written without the `Result.` prefix, in expressions and in patterns, as long as nothing else in scope is named `Ok` or `Err` (the same holds for `Some` and `None`). The standard library keeps the qualified spelling.

Three operators handle a `Result` at the call site: `?` propagates, `!` unwraps or panics, `??` falls back to a default. The rest of this page shows each one, then `match` for full control.

## `?` — propagate

On error, `?` returns it to the caller immediately. Only works inside functions that themselves return `Result`.

```milo
from "std/fs" import { readFile }
from "std/io" import { IoError }

fn loadConfig(path: &string): Result<string, IoError> {
    let text = readFile(path)?     // on error, returns it
    return Result.Ok(text)
}
```

## `!` — unwrap or panic

Crashes on error. Appropriate for top-level code, scripts, or when you've already validated the input.

```milo
from "std/fs" import { readFile }

fn main(): i32 {
    let text = readFile("count.txt")!   // panic if the file is missing
    print(text)
    return 0
}
```

## `??` — default on error

Discards the error and substitutes a value.

```milo
from "std/fs" import { readFile }

fn main(): i32 {
    let text = readFile("count.txt") ?? "0"   // missing file? use "0"
    print(text)
    return 0
}
```

## `match` — full control

When you need different behavior for success and failure:

```milo
from "std/fs" import { readFile }
from "std/io" import { IoError }
from "std/strconv" import { parseInt }

fn readNumber(path: &string): Result<i64, IoError> {
    let text = readFile(path)?
    match parseInt(text.trim()) {
        Option.Some(n) => { return Result.Ok(n) }
        Option.None => { return Result.Err(IoError.Other("not a number")) }
    }
}

fn main(): i32 {
    match readNumber("count.txt") {
        Result.Ok(n)  => { return n as i32 }
        Result.Err(e) => {
            print("error: ", e)
            return 1
        }
    }
}
```

## Typed errors

The default `Result<T>` carries a string message. When you need to branch on the *cause* of failure, define an error enum:

```milo skip
// Sketch: `...` stands in for the body. std/io already defines IoError with these
// variants plus IsDirectory, AlreadyExists and Other.
enum IoError {
    NotFound(string),
    PermissionDenied(string),
}

fn readFile(path: string): Result<string, IoError> { ... }
```

Callers match on specific failure modes. Patterns do not nest, so bind the error and match it in a second step:

```milo
from "std/fs" import { readFile }
from "std/io" import { IoError }

fn parse(data: string) {
    print("parsed ", data.len, " bytes")
}

fn useDefaults() {
    print("using defaults")
}

match readFile("config.toml") {
    Result.Ok(data) => { parse(data) }
    Result.Err(e) => {
        match e {
            IoError.NotFound(_)         => { useDefaults() }
            IoError.PermissionDenied(p) => { print("denied: ", p) }
            _                           => { print("other error") }
        }
    }
}
```

## Auto-conversion with `?`

When your error enum wraps another error type, `?` converts automatically:

```milo
from "std/fs" import { readFile }
from "std/io" import { IoError }

enum ParseError {
    BadNumber(string),
}

enum AppError {
    Io(IoError),         // wraps IoError
    Parse(ParseError),   // wraps ParseError
}

fn parseNum(text: string): Result<i32, ParseError> {
    return Result.Ok(text.len as i32)
}

fn process(path: string): Result<i32, AppError> {
    let text = readFile(path)?        // IoError -> AppError.Io, automatic
    let n = parseNum(text)?           // ParseError -> AppError.Parse, automatic
    return Result.Ok(n)
}
```

In Rust, this requires the `thiserror` crate or hand-written `From` implementations. In Milo, the compiler generates the conversion automatically.

## Boxed errors and `.context`

When a caller only needs to *report* an error, one enum per layer is too much. The
prelude declares `interface Error { fn message(self: &Self): string }`, and a fn that
returns `Result<T, Heap<Error>>` takes any error through `?`: a struct or enum with a
`message` method is boxed, and a plain `string` error arrives as an `ErrorMessage`.
`r.context("note")` adds a layer on the way up; its message reads outermost first.

```milo
struct NotFound { path: string }
impl NotFound {
    fn message(self: &Self): string { return "not found: " + self.path }
}

fn readConfig(path: string): Result<string, NotFound> {
    return Result.Err(NotFound { path: path })
}

fn parse(text: string): Result<i64, string> {
    return Result.Ok(text.len)
}

fn load(path: string): Result<i64, Heap<Error>> {
    let text = readConfig(path).context("loading config")?   // NotFound, boxed
    let n = parse(text).context("parsing")?                   // string, boxed as ErrorMessage
    return Result.Ok(n)
}

fn main() {
    match load("x.toml") {
        Result.Ok(n) => { print(n) }
        Result.Err(e) => { print(e.message()) }   // loading config: not found: x.toml
    }
}
```

This is the `anyhow` shape: `Heap<Error>` where the type no longer matters, a typed
enum where a caller will match on it.

Next: [Ownership](./ownership)
