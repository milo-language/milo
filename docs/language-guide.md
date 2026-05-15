# The Milo Language Guide

Milo is a memory-safe systems language that compiles to native binaries via LLVM.
It uses move semantics and second-class references to guarantee safety at compile time —
no garbage collector, no reference counting, no lifetime annotations.

If you know TypeScript, Go, or Swift, most Milo code will look familiar.

## Getting Started

```bash
# Install prerequisites: Bun (https://bun.sh) and LLVM/Clang

# Compile and run
bun run src/main.ts build examples/hello.milo -o hello
./hello

# Emit LLVM IR (useful for understanding what the compiler does)
bun run src/main.ts emit-ir examples/hello.milo
```

## Hello, Milo

```milo
fn main(): i32 {
    print("Hello, Milo!")
    return 0
}
```

Every Milo program starts at `main`, which returns an `i32` exit code.

---

## Variables

`let` declares an immutable binding. `var` declares a mutable one.

```milo
let x: i32 = 42       // immutable — cannot be reassigned
var count: i32 = 0     // mutable — can be reassigned
count = count + 1

let name = "Milo"      // type inference works
```

Under the hood, `let` maps to an SSA register and `var` maps to a stack allocation.
This means what you write is what LLVM sees — no hidden costs.

---

## Primitive Types

| Type | Description |
|------|-------------|
| `i8`, `i16`, `i32`, `i64` | Signed integers |
| `u8`, `u16`, `u32`, `u64` | Unsigned integers |
| `f32`, `f64` | Floating-point |
| `bool` | Boolean (`true` / `false`) |
| `int` | Alias for `i64` |
| `float` | Alias for `f64` |
| `byte` | Alias for `u8` |

### Number Literals

```milo
let dec: i32 = 1_000_000      // decimal with underscores for readability
let hex: i32 = 0xFF            // hexadecimal
let bin: i32 = 0b1010_1010     // binary
```

### Bitwise Operators

Integer-only. C-style precedence: `~` (unary) > `<<` `>>` > `&` > `^` > `|`.

```milo
let mask: i32 = 0xFF & 0x0F    // 15
let combined = a | b
let toggled = a ^ b
let shifted = a << 2
let negated = ~a               // ones-complement
```

### Number → String

```milo
let n: i64 = 42
let s = n.to_string()          // "42"
let pi: f64 = 3.14
let t = pi.to_string()         // "3.14"
```

### Type Casts

Use `as` to convert between numeric types:

```milo
let big: i64 = 42
let small = big as i32

let f: f64 = 3.7
let n = f as i32       // truncates to 3

let b: u8 = 200
let wide = b as i32
```

### Character Literals

Character literals produce `u8` values:

```milo
let ch: u8 = 'A'       // 65
let newline = '\n'
```

---

## Functions

```milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: string): void {
    print("hello, %s", name)
}
```

### Generic Functions

```milo
fn identity<T>(x: T): T {
    return x
}

let n = identity(42)       // T inferred as i32
let s = identity("hello")  // T inferred as string
```

### Built-in Functions

| Function | Description |
|----------|-------------|
| `print(fmt, ...)` | Print formatted text with trailing newline |
| `exit(code)` | Exit the process |
| `json_stringify(val)` | Serialize a struct to JSON string |
| `embed_file(path)` | Embed file contents as string at compile time |

---

## Strings

Strings are owned UTF-8 byte buffers (similar to Rust's `String`). They are heap-allocated
with a `{ptr, len, cap}` layout.

```milo
let greeting = "hello"
let name = "world"

// Concatenation
let message = greeting + " " + name

// Length
let n = message.len

// Byte indexing
let first_byte = message[0]    // u8

// Slicing — zero-copy view (returns &string, no allocation)
let hello = message[0..5]       // &string, borrows from message
print(hello)                    // auto-deref: methods/print/indexing all work
var view = message[0..3]
view = message[3..5]            // reassignable, just updates the pointer

// Owned copy — when you need a string that outlives the source
let owned = message.substr(0, 5)  // allocates new string

// Deep copy
let copy = greeting.clone()

// Comparison
if greeting == "hello" {
    print("match!")
}

// Building strings character by character
var s: string = ""
s.push('h')
s.push('i')
```

Strings auto-coerce to `*u8` when passed to FFI functions.

---

## Structs

Structs are value types with move semantics.

```milo
struct Point {
    x: i32,
    y: i32,
}

let p = Point { x: 10, y: 20 }
print("%d", p.x)

// Mutable struct
var q = Point { x: 1, y: 2 }
q.x = 99
```

### Generic Structs

```milo
struct Pair<A, B> {
    first: A,
    second: B,
}

let p = Pair { first: 42, second: "hello" }
```

### Methods (Inherent `impl`)

```milo
struct Dog {
    age: i32,
}

impl Dog {
    fn get_age(self: &Self): i32 {
        return self.age
    }
}

let d = Dog { age: 7 }
print("%d", d.get_age())
```

---

## Enums (Sum Types)

Enums are tagged unions. Variants can carry payloads.

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
```

### Pattern Matching

`match` is exhaustive — the compiler requires you to handle every variant.

```milo
fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r) => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
        Shape.Point => { return 0.0 }
    }
}
```

Use `_` as a wildcard to match remaining variants:

```milo
match s {
    Shape.Circle(r) => { print("circle") }
    _ => { print("something else") }
}
```

### Generic Enums

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

Both `Option` and `Result` are built into the language with special syntax support (see below).

---

## Option and Result

### Option Sugar

`T?` is shorthand for `Option<T>`:

```milo
fn find(id: i32): i32? {
    if id == 1 {
        return Option.Some(42)
    }
    return Option.None
}
```

### Unwrap, Propagate, Default

```milo
let val = opt!          // unwrap — panic if None (with source location)
let val = opt?          // propagate — return None from current function if None
let val = opt ?? 0      // default — use 0 if None
```

These also work with `Result`:

```milo
fn validate(x: i32): Result<i32> {
    if x < 0 {
        return Result.Err("negative")
    }
    return Result.Ok(x)
}

fn double_valid(x: i32): Result<i32> {
    let v = validate(x)?                // propagate Err
    return Result.Ok(v * 2)
}
```

### if let

For when you only care about one variant:

```milo
let x = Option.Some(42)
if let Option.Some(val) = x {
    print("got %d", val)
}
```

---

## Arrays

Fixed-size, stack-allocated, bounds-checked.

```milo
let arr = [10, 20, 30]
print("%d", arr[0])
print("%lld", arr.len)

// Repeat syntax
let zeros = [0; 100]      // 100 zeros

// Mutable arrays
var buf: [u8; 8192] = [0; 8192]
buf[0] = 42
```

Out-of-bounds access is a runtime panic, not silent corruption.

---

## Vec\<T\> — Dynamic Arrays

```milo
var v: Vec<i32> = Vec.new()
v.push(10)
v.push(20)
v.push(30)

print("%d", v[0])           // bounds-checked
print("%lld", v.len)

let last = v.pop()            // removes and returns last element
```

Vec owns its elements and frees them when it goes out of scope.

```milo
// Vec of strings
var names: Vec<string> = Vec.new()
names.push("Alice")
names.push("Bob")
print(names[0])
```

---

## HashMap\<K, V\>

Open-addressing hash table with FNV-1a hashing.

```milo
var m: HashMap<string, i32> = HashMap.new()
m.insert("hello", 42)
m.insert("world", 99)

print("%ld", m.len)

if m.contains("hello") {
    print("found it")
}

let val = m.get("hello")       // returns Option<i32>
if let Option.Some(v) = val {
    print("value: %d", v)
}

m.remove("hello")
```

---

## Box\<T\> — Heap Allocation

`Box<T>` is a single-owner heap pointer. Useful for recursive data structures.

```milo
// Recursive enum — must box the recursive case
enum Tree {
    Node(Box<Tree>, Box<Tree>),
    Leaf(i32),
}

fn sum(t: Tree): i32 {
    match t {
        Tree.Leaf(n) => { return n }
        Tree.Node(left, right) => {
            return sum(*left) + sum(*right)
        }
    }
    return 0
}

let tree = Tree.Node(
    Box(Tree.Leaf(1)),
    Box(Tree.Leaf(2))
)
print("%d", sum(tree))   // 3
```

Box auto-frees when it goes out of scope.

---

## Ownership and Move Semantics

Values have a single owner. Assignment transfers ownership.

```milo
let a = "hello"
let b = a          // a is moved into b
// a is now invalid — using it here is a compile error
print(b)         // fine
```

This applies to structs, enums, strings, Vec, HashMap, and Box.
Primitive types (`i32`, `bool`, `f64`, etc.) are copied, not moved.

### Move in Branches

The compiler tracks moves through control flow:

```milo
let p = Point { x: 1, y: 2 }
if condition {
    consume(p)     // p moved here
} else {
    consume(p)     // p moved here — OK, only one branch executes
}
// p is invalid after the if/else regardless of which branch ran
```

---

## References (Second-Class)

References can appear as function parameters and local variables, but cannot be
returned from functions or stored in structs/collections. This eliminates dangling
references by construction — no lifetime annotations needed.

```milo
// Immutable reference
fn length(s: &string): i64 {
    return s.len
}

// Mutable reference
fn double(x: &mut i32) {
    x = x * 2
}

var n: i32 = 21
double(n)          // n is now 42

// Ref locals — zero-copy slices
fn process(content: &string): void {
    let header = content[0..80]   // &string slice, no allocation
    print(header.len)             // auto-deref for methods/fields
}
```

**What you can't do:**

```milo
fn bad(): &string { ... }         // COMPILE ERROR: can't return a reference
struct Bad { ref: &string }       // COMPILE ERROR: can't store a reference
```

This is Milo's key insight: by restricting where references can live, you get
memory safety without a borrow checker or lifetime annotations.

---

## Traits

Traits define shared behavior across types.

```milo
trait Eq {
    fn eq(self: &Self, other: &Self): bool
}

struct Point { x: i32, y: i32 }

impl Eq for Point {
    fn eq(self: &Self, other: &Self): bool {
        return self.x == other.x && self.y == other.y
    }
}
```

### Default Methods

```milo
trait Greet {
    fn greet(self: &Self): i32 {
        return 42    // default implementation
    }
}

struct Cat { name: i32 }
impl Greet for Cat {}    // uses the default
```

### Generic Bounds

```milo
fn print_if_equal<T: Eq>(a: &T, b: &T) {
    if a.eq(b) {
        print("equal!")
    }
}
```

Multiple bounds:

```milo
fn process<T: Eq + Hash>(item: &T) { ... }
```

### Supertraits

```milo
trait Ord: Eq {
    fn compare(self: &Self, other: &Self): i32
}
```

### @derive

Auto-generate trait implementations:

```milo
@derive(Eq)
struct Point { x: i32, y: i32 }
```

---

## Closures

Arrow syntax, non-escaping. Closures can be passed as function arguments
or stored in local variables, but cannot be returned or stored in structs.

```milo
// Expression closure
fn apply(f: fn(i32): i32, x: i32): i32 {
    return f(x)
}
let result = apply((x: i32) => x * 2, 21)   // 42

// Block closure
let result = apply((x: i32): i32 => {
    let doubled = x * 2
    return doubled + 1
}, 20)   // 41

// Stored in local variable
let inc = (x: i32) => x + 1
```

### Capturing Variables

Closures capture by reference — mutations are visible outside:

```milo
fn call_it(f: fn(): void) {
    f()
}

var count: i32 = 0
call_it(() => { count = count + 1 })
call_it(() => { count = count + 1 })
print("%d", count)   // 2
```

---

## Control Flow

```milo
// if/else
if x > 0 {
    print("positive")
} else if x == 0 {
    print("zero")
} else {
    print("negative")
}

// while
var i: i32 = 0
while i < 10 {
    if i == 5 { break }
    if i % 2 == 0 { i = i + 1; continue }
    print("%d", i)
    i = i + 1
}
```

---

## Modules and Imports

```milo
// Import everything from a file
import "math.milo"

// Import specific items
from "std/http" import { Request, Response, serve }

// Import from a relative path
from "lib/math" import { add }
```

Imports are resolved recursively and deduplicated.

---

## C FFI

Declare external C functions with `extern`:

```milo
extern fn puts(s: *u8): i32
extern fn printf(fmt: *u8, ...): i32
extern fn malloc(size: u64): *u8

fn main(): i32 {
    puts("Hello from C!")
    printf("number: %d\n", 42)
    return 0
}
```

Strings auto-coerce to `*u8` when passed to extern functions.

---

## JSON Serialization

`json_stringify` is a built-in that serializes any struct to a JSON string:

```milo
struct User {
    name: string,
    age: i32,
    active: bool,
}

let user = User { name: "Chad", age: 30, active: true }
let json = json_stringify(user)
// {"name":"Chad","age":30,"active":true}
```

---

## Compile-Time File Embedding

`embed_file` inlines file contents as a string at compile time:

```milo
let html = embed_file("index.html")
```

---

## HTTP Server (Standard Library)

Milo includes an HTTP server in `std/http`:

```milo
from "std/http" import { Request, Response, serve }

fn handler(req: &Request): Response {
    if req.path == "/" {
        return Response.Html("<h1>Hello!</h1>")
    }
    if req.path == "/api" {
        return Response.Json("{\"status\": \"ok\"}")
    }
    return Response.NotFound
}

fn main(): i32 {
    serve(8080, handler)
    return 0
}
```

Response variants: `Text(string)`, `Html(string)`, `Json(string)`, `NotFound`, `Status(i32, string, string)`.

---

## Complete Example: JSON Parser

This example exercises enums with complex payloads, Box, Vec, structs, recursion, and string operations. See [`examples/json_parser.milo`](../examples/json_parser.milo) for the full source.

```milo
struct JsonKV {
    key: string,
    value: Box<JsonValue>,
}

enum JsonValue {
    Null,
    Bool(bool),
    Number(i64),
    Str(string),
    Array(Vec<Box<JsonValue>>),
    Object(Vec<JsonKV>),
}

fn parse_value(s: &string, pos: &mut i64): Box<JsonValue> {
    skip_ws(s, pos)
    let ch = s[pos]
    if ch == '"' { return parse_string(s, pos) }
    if ch == '{' { return parse_object(s, pos) }
    if ch == '[' { return parse_array(s, pos) }
    // ... etc
}
```

---

## Complete Example: FizzBuzz

```milo
fn main(): i32 {
    var i: i32 = 1
    while i <= 20 {
        if i % 15 == 0 {
            print("FizzBuzz")
        } else if i % 3 == 0 {
            print("Fizz")
        } else if i % 5 == 0 {
            print("Buzz")
        } else {
            print(".")
        }
        i = i + 1
    }
    return 0
}
```

---

## Complete Example: Binary Tree

```milo
enum Tree {
    Node(Box<Tree>, Box<Tree>),
    Leaf(i32),
}

fn sum(t: Tree): i32 {
    match t {
        Tree.Leaf(n) => { return n }
        Tree.Node(left, right) => {
            return sum(*left) + sum(*right)
        }
    }
    return 0
}

fn main(): i32 {
    let tree = Tree.Node(
        Box(Tree.Node(Box(Tree.Leaf(1)), Box(Tree.Leaf(2)))),
        Box(Tree.Node(Box(Tree.Leaf(3)), Box(Tree.Leaf(4))))
    )
    print("sum: %d", sum(tree))   // sum: 10
    return 0
}
```

---

## Quick Reference

| Concept | Syntax |
|---------|--------|
| Immutable binding | `let x = 42` |
| Mutable binding | `var x = 42` |
| Type annotation | `let x: i32 = 42` |
| Function | `fn name(a: i32): i32 { ... }` |
| Generic function | `fn name<T>(x: T): T { ... }` |
| Struct | `struct Name { field: Type }` |
| Enum | `enum Name { Variant(Type), Empty }` |
| Match | `match val { Variant(x) => { ... } }` |
| If let | `if let Variant(x) = val { ... }` |
| Option shorthand | `T?` for `Option<T>` |
| Unwrap | `expr!` |
| Propagate | `expr?` |
| Default | `expr ?? default` |
| Array | `[1, 2, 3]` or `[0; 100]` |
| Vec | `var v: Vec<i32> = Vec.new()` |
| HashMap | `var m: HashMap<K, V> = HashMap.new()` |
| Box | `Box(value)`, deref with `*boxed` |
| Reference param | `fn f(x: &T)` or `fn f(x: &mut T)` |
| Closure | `(x: i32) => x * 2` |
| Import | `import "file.milo"` |
| Named import | `from "path" import { A, B }` |
| FFI | `extern fn name(args): ret` |
| Trait | `trait Name { fn method(self: &Self): T }` |
| Impl trait | `impl Trait for Type { ... }` |
| Impl methods | `impl Type { ... }` |
| Derive | `@derive(Eq)` |
| Generic bound | `<T: Eq + Hash>` |
| Cast | `expr as Type` |
| Embed file | `embed_file("path")` |
| JSON serialize | `json_stringify(struct_val)` |
| String slice | `s[start..end]` |
| Number to string | `n.to_string()` |
| Bitwise | `& \| ^ << >> ~` |
| Hex / binary literal | `0xFF`, `0b1010` |
