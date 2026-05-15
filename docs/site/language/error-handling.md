# Error Handling

Milo uses `Result<T>` and `Result<T, E>` for error handling — no exceptions.

## The basics

Functions that can fail return `Result<T>`:

```milo
fn readNumber(path: &string): Result<i64> {
    let text = read_file(path)?     // ? propagates errors to caller
    return text.trim().parse_i64()
}
```

Three operators for handling results:

| Operator | What it does | When to use |
|----------|-------------|-------------|
| `?` | Propagate error to caller | Inside fallible functions |
| `!` | Unwrap, panic on error | Quick scripts, known-good values |
| `??` | Use default value | When errors are acceptable |

```milo
fn main(): i32 {
    let a = readNumber("count.txt") ?? 0   // default to 0 on error
    let b = readNumber("count.txt")!       // panic if file missing
    print(a + b)
    return 0
}
```

## Matching on results

```milo
fn run(): Result<i32> {
    let n = readNumber("count.txt")?
    return Result.Ok(n)
}

fn main(): i32 {
    match run() {
        Result.Ok(code)  => { return code }
        Result.Err(msg)  => { print("error: ", msg); return 1 }
    }
}
```

## Typed errors

When you need to branch on the cause, use a custom error enum:

```milo
enum IoError {
    NotFound(string),
    PermissionDenied(string),
}

fn readFile(path: string): Result<string, IoError> { ... }

match readFile("config.toml") {
    Result.Ok(data)                         => parse(data)
    Result.Err(IoError.NotFound(_))         => useDefaults()
    Result.Err(IoError.PermissionDenied(p)) => print("denied: ", p)
}
```

## Auto-conversion with ?

`?` auto-wraps errors when the caller's error enum has a matching variant. No conversion boilerplate:

```milo
enum AppError {
    Io(IoError),         // ? auto-wraps IoError -> AppError.Io(e)
    Parse(ParseError),   // ? auto-wraps ParseError -> AppError.Parse(e)
}

fn process(path: string): Result<i32, AppError> {
    let text = readFile(path)?        // IoError -> AppError, automatic
    let data = parseJson(text)?       // ParseError -> AppError, automatic
    return Result.Ok(data.len as i32)
}
```

In Rust, this requires the `thiserror` crate or hand-written `From` implementations. In Milo, the compiler sees that `AppError` has an `Io(IoError)` variant and generates the conversion automatically.

Next: [Ownership →](./ownership)
