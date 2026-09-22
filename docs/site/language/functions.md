# Functions

## Basics

```milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: string): void {
    print("hello, ", name)
}
```

## Generic functions

```milo
fn identity<T>(x: T): T {
    return x
}

let n = identity(42)       // T inferred as i64
let s = identity("hello")  // T inferred as string
```

## Built-in functions

| Function | Description |
|----------|-------------|
| `print(args...)` | Print with trailing newline |
| `exit(code)` | Exit the process |
| `jsonStringify(val)` | Serialize a struct to JSON |

Builtins spelled with an `@` (`@embedFile`, `@targetOs`) run while compiling; they are
listed under [compile-time builtins](/features/annotations#compile-time-builtins).

## Reference parameters

A parameter typed `&T` borrows its argument and `&mut T` may change it. The call passes a
shared borrow bare, `length(s)`, and marks a mutable one, `double(&mut n)`.
[Ownership](./ownership#borrowing) has the rules.
