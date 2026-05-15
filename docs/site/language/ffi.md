# C FFI

Call any C library by declaring external functions.

## Declaring extern functions

```milo
extern fn puts(s: *u8): i32
extern fn printf(fmt: *u8, ...): i32
extern fn sqrt(x: f64): f64
extern fn malloc(size: u64): *u8
```

## Calling them

Extern function calls require an `unsafe` block:

```milo
fn main(): i32 {
    let root = unsafe { sqrt(2.0) }
    print("sqrt(2) = ", root)
    return 0
}
```

## String coercion

Strings auto-coerce to `*u8` when passed to extern functions:

```milo
extern fn puts(s: *u8): i32

fn main(): i32 {
    puts("Hello from C!")    // string -> *u8 automatically
    return 0
}
```

## Compile-time file embedding

Inline file contents as a string at compile time:

```milo
let html = embed_file("index.html")
```
