# Variables & Types

## let and var

`let` declares an immutable binding. `var` declares a mutable one.

```milo
let x = 42          // can't reassign
var count = 0       // can reassign
count = count + 1

let name = "Milo"   // type inference works
```

Under the hood, `let` maps to an SSA register and `var` maps to a stack allocation. What you write is what LLVM sees.

## Primitive types

| Type | Description |
|------|-------------|
| `i8`, `i16`, `i32`, `i64` | Signed integers |
| `u8`, `u16`, `u32`, `u64` | Unsigned integers |
| `f32`, `f64` | Floating-point |
| `bool` | `true` / `false` |
| `int` | Alias for `i64` |
| `float` | Alias for `f64` |
| `byte` | Alias for `u8` |

## Number literals

```milo
let dec: i32 = 1_000_000      // underscores for readability
let hex: i32 = 0xFF            // hexadecimal
let bin: i32 = 0b1010_1010     // binary
```

## Character literals

Character literals produce `u8` values:

```milo
let ch: u8 = 'A'       // 65
let newline = '\n'
```

## Type casts

Use `as` to convert between numeric types:

```milo
let big: i64 = 42
let small = big as i32

let f: f64 = 3.7
let n = f as i32       // truncates to 3
```

## Bitwise operators

Integer-only. C-style precedence.

```milo
let mask: i32 = 0xFF & 0x0F    // 15
let shifted = mask << 2
let negated = ~mask
```

## Control flow

```milo
if x > 0 {
    print("positive")
} else if x == 0 {
    print("zero")
} else {
    print("negative")
}

var i: i32 = 0
while i < 10 {
    if i == 5 { break }
    i = i + 1
}
```

Next: [Functions →](./functions)
