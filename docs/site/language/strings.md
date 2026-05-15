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
s.starts_with("Hello")           // true
s.ends_with("!")                 // true

s.to_lower()                     // "hello, world!"
s.to_upper()                     // "HELLO, WORLD!"
s.trim()                         // removes leading/trailing whitespace

s.split(", ")                    // Vec<string>: ["Hello", "World!"]
s.replace("World", "Milo")      // "Hello, Milo!"
s.index_of("World")             // Option<i64>: Some(7)
s.repeat(3)                      // "Hello, World!Hello, World!Hello, World!"
```

## Building strings

```milo
var s: string = ""
s.push('h')
s.push('i')
// s is now "hi"
```

## Number to string

```milo
let n: i64 = 42
let s = n.to_string()          // "42"

let pi: f64 = 3.14
let t = pi.to_string()         // "3.14"
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
