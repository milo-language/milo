# Enums & Pattern Matching

Each enum variant can carry different data, and the compiler checks that you handle every one. Miss a case and it won't compile.

## Defining enums

Variants can carry data (`Circle` holds a radius) or stand alone (`Point`).

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
```

## Pattern matching

Use `match` to branch on an enum's variant. The compiler checks that you've covered every case -- leave one out and you get a compile error, not a runtime bug.

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r)  => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
        Shape.Point      => { return 0.0 }
    }
}
```

When you don't need to handle every variant individually, use `_` as a catch-all wildcard.

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
match s {
    Shape.Circle(r) => { print("circle") }
    _ => { print("something else") }
}
```

## Generic enums

```milo skip
// Illustrative only: Option and Result are builtins, so this exact source is
// rejected with "'Option' is a builtin enum and cannot be redeclared".
enum Option<T> {
    Some(T),
    None,
}

enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

## Option and Result

`Option<T>` replaces null: `Option.Some(value)` or `Option.None`, and you must check which before using it. `Result<T, E>` replaces exceptions: `Result.Ok(value)` or `Result.Err(error)`, and the compiler won't let you ignore a failure. Both are built-in enums. Propagating or defaulting a failure with `?`, `!` and `??` is covered in [Error Handling](/language/error-handling).

The `Option.` and `Result.` prefixes are optional for these four variants: `Some(3)`, `None`, `Ok(v)` and `Err(e)` work in expressions and in patterns, and resolve to the Option/Result variants whenever nothing else in scope has that name (a function or variable called `Some` wins). The standard library keeps the qualified spelling.

## if let

Sometimes you only care about one variant. `if let` extracts the inner value without a full `match`.

```milo
let x = Option.Some(42)
if let Option.Some(val) = x {
    print("got ", val)
}
```

## Option shorthand

`T?` is shorthand for `Option<T>`, keeping function signatures clean when a value might be absent.

```milo
fn find(id: i32): i32? {
    if id == 1 {
        return Option.Some(42)
    }
    return Option.None
}
```
