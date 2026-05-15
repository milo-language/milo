# Enums & Pattern Matching

Enums are tagged unions — variants can carry data.

## Defining enums

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
```

## Pattern matching

`match` is exhaustive — the compiler rejects unhandled cases.

```milo
fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r)  => 3.14159 * r * r
        Shape.Rect(w, h) => w * h
        Shape.Point      => 0.0
    }
}
```

Use `_` as a wildcard:

```milo
match s {
    Shape.Circle(r) => print("circle")
    _ => print("something else")
}
```

## Generic enums

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

Both `Option` and `Result` are built into the language with special syntax support.

## if let

For when you only care about one variant:

```milo
let x = Option.Some(42)
if let Option.Some(val) = x {
    print("got ", val)
}
```

## Option shorthand

`T?` is shorthand for `Option<T>`:

```milo
fn find(id: i32): i32? {
    if id == 1 {
        return Option.Some(42)
    }
    return Option.None
}
```

Next: [Error Handling →](./error-handling)
