# Enums & Pattern Matching

An enum says "this value is one of these things." Each variant can carry different data, and the compiler ensures you handle every possibility. If you've used `switch` statements before, think of enums + `match` as a strictly better version -- the compiler won't let you forget a case.

## Defining enums

List your variants inside `enum`. A variant can carry data (like `Circle` holds a radius) or stand alone (like `Point`).

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
fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r)  => 3.14159 * r * r
        Shape.Rect(w, h) => w * h
        Shape.Point      => 0.0
    }
}
```

When you don't need to handle every variant individually, use `_` as a catch-all wildcard.

```milo
match s {
    Shape.Circle(r) => print("circle")
    _ => print("something else")
}
```

## Generic enums

Enums can be generic, letting the variant data vary by type parameter.

```milo
enum Option<T> {
    Some(T),
    None,
}

enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

## Built-in enums: Option and Result

`Option` and `Result` are built into the language. They replace two patterns that cause bugs in other languages:

- **Option** replaces null. Instead of a value that might be null (and crash at runtime if you forget to check), `Option<T>` makes the "might be absent" case explicit. The compiler forces you to handle `None` before you can use the inner value.
- **Result** replaces exceptions. Instead of throwing errors that callers might forget to catch, functions return `Result<T, E>`. The success value (`Ok`) and the error (`Err`) are both right there in the type, and the compiler ensures you deal with both.

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

Next: [Error Handling →](./error-handling)
