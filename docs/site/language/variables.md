# Variables & Types

## let and var

`let` declares an immutable binding. `var` declares a mutable one.

```milo
let x = 42          // can't reassign
var count = 0       // can reassign
count += 1          // compound assignment: same as count = count + 1

let name = "Milo"   // type inference works
```

`+=`, `-=`, `*=`, `/=`, `%=`, `&=`, `|=` and `^=` all exist, and the target can be any assignable place (`v[i] += 1`, `p.x -= dx`). There is no `++`.

`let` maps to an SSA register and `var` maps to a stack allocation. What you write is what LLVM sees.

## Destructuring a struct

`let { a, b } = e` binds fields of a struct value by name. `{ a: x }` renames, and
`var { … }` makes the bindings mutable.

```milo
struct Match { start: i64, len: i64, text: string }

let { start, text } = find()
let m = find()
let { len: n } = m      // renamed; m.start is still usable, only len was taken
```

It is the same as writing `let a = e.a` for each field (through a hidden temporary when
`e` is not a place), so the ownership rules are a field read's: a Copy field is copied, a
non-Copy field of a value moves out of it, a field of a `&S` cannot be moved out, and a
struct with `Drop` cannot be taken apart. Fields you do not name stay where they were.

There is no tuple type: two values come back as a named struct and are bound this way.

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
    i += 1
}
```

`break` leaves the loop; `continue` skips the rest of this iteration and starts the next
one. Both work in `while` and in `for`:

```milo
var i: i32 = 0
while i < 10 {
    i += 1
    if i % 2 == 0 { continue }   // even: go straight to the next iteration
    if i == 7 { break }          // stop the loop entirely
    print($"{i}")                // prints 1, 3, 5
}
```

## For loops

Iterate over ranges with `for .. in`:

```milo
for i in 0..10 {
    print(i)
}
```

Or iterate over collections:

```milo
let names = Vec.of("Alice", "Bob", "Charlie")
for name in names {
    print(name)
}
```
