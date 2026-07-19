# Strings

Strings are owned UTF-8 byte buffers with a `{ptr, len, cap}` layout — similar to Rust's `String`. All methods are built-in, no imports needed.

## Basics

```milo
let greeting = "hello"
let name = "world"

let message = greeting + " " + name   // concatenation
let n = message.len                    // length
let first = message[0]                 // byte indexing (u8)
let hello = message[0..5]             // slicing
let copy = greeting.clone()            // deep copy
```

## Built-in methods

```milo
let s = "Hello, World!"

s.contains("World")              // true
s.startsWith("Hello")           // true
s.endsWith("!")                 // true

s.toLower()                     // "hello, world!"
s.toUpper()                     // "HELLO, WORLD!"
s.trim()                         // removes leading/trailing whitespace

s.split(", ")                    // Vec<string>: ["Hello", "World!"]
s.replace("World", "Milo")      // "Hello, Milo!"
s.indexOf("World")             // i64: 7, or -1 if not found
s.repeat(3)                      // "Hello, World!Hello, World!Hello, World!"
```

## Building strings

```milo
var s: string = ""
s.push('h')            // one byte
s.push('i')
s.pushStr(" there")    // a whole string, appended in place
// s is now "hi there"
```

`pushStr` grows the buffer amortized. `s = s + t` in a loop is quadratic — it
reallocates and recopies the whole accumulator on every concat.

## Iterating

A string is a UTF-8 byte buffer, and iterating one directly yields **bytes**:

```milo
for b in s {              // b: u8
    if b == 44 { ... }    // scanning for ',' — no decoding needed
}

for i, b in s { ... }     // i: i64 byte offset, b: u8
```

For text, iterate codepoints instead. This decodes as it goes rather than
building a `Vec<i32>`:

```milo
for cp in "héllo".codePoints() {     // cp: i32
    print($"{cp}")
}

for at, cp in "héllo".codePoints() { // at: i64 BYTE offset of cp
    print($"{at}: {cp}")
}
```

Malformed UTF-8 never stalls or reads out of bounds — a bad sequence yields
U+FFFD and advances one byte.

Indexing is byte-oriented, so `s[i]` is a `u8` and `charAt` will split a
multi-byte codepoint. To decode at a known offset without a loop, use
`decodeCodepoint` from `std/unicode`, which returns the value and its byte
width:

```milo
from "std/unicode" import { decodeCodepoint }

let c = decodeCodepoint(s, 0)
print($"{c.value} occupies {c.size} bytes")
```

## Number to string

```milo
let n: i64 = 42
let s = n.toString()          // "42"

let pi: f64 = 3.14
let t = pi.toString()         // "3.14"
```

## String comparison

```milo
if greeting == "hello" {
    print("match!")
}
```

## FFI

Strings auto-coerce to `*u8` when passed to `extern fn` declarations.

Next: [Traits →](./traits)
