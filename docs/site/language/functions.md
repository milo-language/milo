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

let n = identity(42)       // T inferred as i32
let s = identity("hello")  // T inferred as string
```

## Built-in functions

| Function | Description |
|----------|-------------|
| `print(args...)` | Print with trailing newline |
| `exit(code)` | Exit the process |
| `json_stringify(val)` | Serialize a struct to JSON |
| `embed_file(path)` | Embed file contents at compile time |

## Reference parameters

Functions can borrow values with `&T` (immutable) or `&mut T` (mutable):

```milo
fn length(s: &string): i64 {
    return s.len
}

fn double(x: &mut i32) {
    x = x * 2
}

var n: i32 = 21
double(n)          // n is now 42
```

Milo auto-borrows at call sites — you write `double(n)` not `double(&n)`.

See [Ownership](./ownership) for why references are restricted to function parameters.

Next: [Structs →](./structs)
