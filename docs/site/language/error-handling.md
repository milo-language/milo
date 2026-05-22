# Error Handling

Milo has no exceptions and no null. Errors are values — the type system makes you handle them explicitly. If a function can fail, its return type says so, and the compiler ensures you deal with it.

## Result basics

Functions that can fail return `Result<T>`. This is an enum with two variants: `Result.Ok(value)` on success, `Result.Err(message)` on failure. You can never accidentally ignore an error.

```milo
fn readNumber(path: &string): Result<i64> {
    let text = readFile(path)?
    return text.trim().parseI64()
}
```

## The `?` operator — propagate errors

The `?` operator says "if this failed, return the error to my caller." It only works inside functions that themselves return `Result`. This is the most common way to handle errors — let them bubble up to the right level.

```milo
fn loadConfig(path: &string): Result<string> {
    let text = readFile(path)?     // error? return it to our caller
    return Result.Ok(text)
}
```

## The `!` operator — unwrap or panic

The `!` operator says "I'm sure this will succeed — crash if it doesn't." Use it in top-level code, quick scripts, or when you've already validated the input. In production code, prefer `?` or `??`.

```milo
fn main(): i32 {
    let n = readNumber("count.txt")!   // panic if file missing
    print(n)
    return 0
}
```

## The `??` operator — provide a default

The `??` operator says "if this failed, use this value instead." The error is silently discarded. Good for cases where a sensible fallback exists.

```milo
fn main(): i32 {
    let n = readNumber("count.txt") ?? 0   // missing file? just use 0
    print(n)
    return 0
}
```

## Matching on results

When you need to handle success and failure differently, use `match`. This gives you full control — you can inspect the error, log it, recover, or take different paths.

```milo
fn run(): Result<i32> {
    let n = readNumber("count.txt")?
    return Result.Ok(n)
}

fn main(): i32 {
    match run() {
        Result.Ok(code)  => { return code }
        Result.Err(msg)  => {
            print("error: ", msg)
            return 1
        }
    }
}
```

## Typed errors with `Result<T, E>`

The default `Result<T>` carries a string error message. When you need to branch on the *cause* of a failure — not just whether it failed — define a custom error enum and use `Result<T, E>`.

```milo
enum IoError {
    NotFound(string),
    PermissionDenied(string),
}

fn readFile(path: string): Result<string, IoError> { ... }
```

Now callers can match on specific failure modes:

```milo
match readFile("config.toml") {
    Result.Ok(data)                         => parse(data)
    Result.Err(IoError.NotFound(_))         => useDefaults()
    Result.Err(IoError.PermissionDenied(p)) => print("denied: ", p)
}
```

## Auto-conversion with `?`

When your function's error enum has a variant that wraps another error type, `?` auto-converts for you. No conversion boilerplate needed.

```milo
enum AppError {
    Io(IoError),         // wraps IoError
    Parse(ParseError),   // wraps ParseError
}
```

The compiler sees that `AppError` has an `Io(IoError)` variant, so `?` on a `Result<_, IoError>` automatically wraps the error into `AppError.Io(e)`:

```milo
fn process(path: string): Result<i32, AppError> {
    let text = readFile(path)?        // IoError -> AppError.Io, automatic
    let data = parseJson(text)?       // ParseError -> AppError.Parse, automatic
    return Result.Ok(data.len as i32)
}
```

In Rust, this requires the `thiserror` crate or hand-written `From` implementations. In Milo, the compiler generates the conversion automatically.

Next: [Ownership →](./ownership)
