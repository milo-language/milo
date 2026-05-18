# The Milo Language Guide

Milo is a memory-safe systems language that compiles to native binaries via LLVM.
It uses move semantics and second-class references to guarantee safety at compile time —
no garbage collector, no reference counting, no lifetime annotations.

Milo enforces five safety guardrails: memory safety (move semantics, bounds checking),
null safety (Option\<T\>), race safety (Send/Sync traits), overflow safety (compile-time
checks + debug-mode traps), and coercion safety (no implicit type conversions).

The syntax is designed to be readable on first contact — no surprising sigils or ceremony.

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

### Type Aliases

```milo
type Meters = f64
type Altitude = i32(0..50000)     // with range constraint
```

### Number Literals

```milo
let dec: i32 = 1_000_000      // decimal with underscores for readability
let hex: i32 = 0xFF            // hexadecimal
let bin: i32 = 0b1010_1010     // binary
```

### Integer Overflow Safety

Milo prevents silent integer overflow at multiple levels:

**Compile-time** — literals and constant expressions are range-checked:

```milo
let x: i8 = 200              // error: integer literal 200 overflows i8 (range -128..127)
let y: i32 = 2147483647 + 1  // error: constant expression overflows i32
```

**Runtime (debug builds)** — arithmetic traps on overflow with source location:

```milo
let x: i32 = 2147483647
let y = x + 1     // runtime error: integer overflow at main.milo:2
```

Build with `--debug` to enable overflow traps. Default (`-O2`) and `--release` (`-O3`) builds use wrapping arithmetic for performance.

Checked operations: `+`, `-`, `*`, and unary negation (`-x`) on all integer types.

**Explicit overflow control** — methods for when you need specific overflow behavior:

```milo
let a: u8 = 255
a.wrappingAdd(1)     // 0 — wraps, even in debug builds
a.saturatingAdd(1)   // 255 — clamps to max
let r = a.checkedAdd(1)  // Option.None — returns None on overflow
```

Available: `wrappingAdd/Sub/Mul`, `saturatingAdd/Sub/Mul`, `checkedAdd/Sub/Mul`.

### Ranged Integer Types

Type aliases with range constraints, inspired by Ada/SPARK. Range checks are always-on in all build modes.

```milo
type Altitude = i32(0..50000)
type Temperature = i32(-100..100)

let alt: Altitude = 30000         // ok
let bad: Altitude = 60000         // compile error: value 60000 is out of range
```

Dynamic values are checked at runtime:

```milo
fn readSensor(): i32 { ... }

let alt: Altitude = readSensor()  // runtime check: traps if value outside 0..50000
```

**Range propagation** — the compiler tracks ranges through arithmetic and eliminates runtime checks when it can prove the result fits:

```milo
type SmallInt = i32(0..100)
type MediumInt = i32(0..200)

let a: SmallInt = 50
let b: SmallInt = 100
let sum: MediumInt = a + b   // no runtime check — compiler proves (0..100)+(0..100) ⊆ (0..200)
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
let s = n.toString()          // "42"
let pi: f64 = 3.14
let t = pi.toString()         // "3.14"
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
| `jsonStringify(val)` | Serialize a struct to JSON string |
| `embedFile(path)` | Embed file contents as string at compile time |

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
let firstByte = message[0]    // u8

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

### String Methods

```milo
let s = "Hello, World!"

s.toLower()         // "hello, world!"
s.toUpper()         // "HELLO, WORLD!"
s.trim()            // strip leading/trailing whitespace
s.trimStart()       // strip leading whitespace
s.trimEnd()         // strip trailing whitespace
s.split(",")        // Vec<string>: ["Hello", " World!"]
s.contains("World") // true
s.startsWith("He")  // true
s.endsWith("!")     // true
s.indexOf("World")      // 7
s.lastIndexOf("l")      // 10
s.replace("World", "Milo")  // "Hello, Milo!"
s.padStart(15, " ")     // "  Hello, World!"
s.padEnd(15, ".")       // "Hello, World!.."
s.substr(0, 5)          // "Hello" (owned copy)
```

### String Utility Functions (std/string)

```milo
from "std/string" import { strSplitWords, strSplitWhitespace }

let words = strSplitWords("Hello, World!")       // ["hello", "world"] (lowercased, alpha-only)
let tokens = strSplitWhitespace("a  b\tc")       // ["a", "b", "c"]
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
    fn getAge(self: &Self): i32 {
        return self.age
    }
}

let d = Dog { age: 7 }
print("%d", d.getAge())
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

fn doubleValid(x: i32): Result<i32> {
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

### Functional methods

```milo
let nums: Vec<i32> = [1, 2, 3, 4, 5]
let doubled = nums.map((n: &i32) => n * 2)       // [2, 4, 6, 8, 10]
let evens = nums.filter((n: &i32) => n % 2 == 0)  // [2, 4]
let hasNeg = nums.any((n: &i32) => n < 0)          // false
let allPos = nums.all((n: &i32) => n > 0)          // true
nums.each((n: &i32) => print("%d", n))             // side effects

let words: Vec<string> = ["hello", "world"]
print(words.join(", "))                             // "hello, world"
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

let v = m.getOrDefault("hello", 0)  // returns i32 directly (0 if missing)

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
fn printIfEqual<T: Eq>(a: &T, b: &T) {
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

Arrow syntax. Closures can be passed as function arguments
or stored in local variables.

```milo
// Expression closure
let double = (x: i32) => x * 2

// Block closure
let clamp = (x: i32): i32 => {
    if x < 0 { return 0 }
    if x > 100 { return 100 }
    return x
}

// Passed as argument
fn apply(f: (i32) => i32, x: i32): i32 {
    return f(x)
}
let result = apply(double, 21)   // 42
```

### Capturing Variables

Regular closures capture by reference — mutations are visible outside:

```milo
var count: i32 = 0
let inc = () => { count = count + 1 }
inc()
inc()
print(count)   // 2
```

### Move Closures

`move` closures capture by value (copy into a heap-allocated environment).
Safe to return from functions, store in structs, and send to threads.

```milo
fn makeAdder(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x + n
    }
}

let add5 = makeAdder(5)
print(add5(3))    // 8
print(add5(10))   // 15

// Compose closures
fn compose(f: (i32) => i32, g: (i32) => i32): (i32) => i32 {
    return move (x: i32): i32 => { return f(g(x)) }
}
let add5ThenDouble = compose(makeMultiplier(2), makeAdder(5))
```

### Closures in Structs

```milo
struct Handler {
    name: string,
    callback: (i32) => i32,
}

let h = Handler { name: "doubler", callback: makeMultiplier(2) }
let cb = h.callback
print(cb(10))   // 20
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
// Import specific items (required — no wildcard imports)
from "std/http" import { Context, Response, Router, serveRouter }

// Import from a relative path
from "lib/math" import { add, multiply }
```

All imports must be explicit — list exactly which symbols you use. No `import *` or bare `import "path"`. The LSP provides autocomplete for both module paths and symbols.

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

`jsonStringify` is a built-in that serializes any struct to a JSON string:

```milo
struct User {
    name: string,
    age: i32,
    active: bool,
}

let user = User { name: "Chad", age: 30, active: true }
let json = jsonStringify(user)
// {"name":"Chad","age":30,"active":true}
```

---

## Compile-Time File Embedding

`embedFile` inlines file contents as a string at compile time:

```milo
let html = embedFile("index.html")
```

---

## HTTP Server (Standard Library)

Milo includes a Hono-inspired HTTP server in `std/http` with a router, context object, middleware, path params, query strings, cookies, and request body access.

### Basic Server

For simple cases, `serve` takes a port and a handler:

```milo
from "std/http" import { Request, Response, serve }

fn handler(req: &Request): Response {
    if req.path == "/" {
        return Response.Html("<h1>Hello!</h1>")
    }
    return Response.NotFound
}

fn main(): i32 {
    serve(8080, handler)
    return 0
}
```

### Router + Context

For real apps, use `Router` with route handlers that receive a mutable `Context`:

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r = Router.new()

    r.get("/", fn(ctx: &mut Context): Response {
        return ctx.text("Hello from Milo!")
    })

    r.get("/users/:id", fn(ctx: &mut Context): Response {
        let id = ctx.param("id")
        ctx.setHeader("X-User-Id", id.clone())
        return ctx.json($"\{\"id\": \"{id}\"}")
    })

    r.get("/search", fn(ctx: &mut Context): Response {
        let q = ctx.query("q")
        return ctx.text($"results for: {q}")
    })

    serveRouter(8080, r)
    return 0
}
```

### Route Methods

```milo
r.get(pattern, handler)      // GET
r.post(pattern, handler)     // POST
r.put(pattern, handler)      // PUT
r.delete(pattern, handler)   // DELETE
r.all(pattern, handler)      // any method
```

### Context Methods

| Method | Description |
|--------|-------------|
| `ctx.param("name")` | Extract path parameter (`:name` in pattern) |
| `ctx.query("key")` | Extract query string value (`?key=value`) |
| `ctx.header("name")` | Read request header (case-insensitive) |
| `ctx.cookie("name")` | Read cookie value from request |
| `ctx.req.body` | Access raw request body |
| `ctx.setStatus(code)` | Set response status code |
| `ctx.setHeader(name, value)` | Add response header |
| `ctx.setCookie(name, value)` | Set response cookie |
| `ctx.setCookieWithOptions(name, value, opts)` | Set cookie with options (`"Path=/; HttpOnly"`) |
| `ctx.deleteCookie(name)` | Delete cookie (Max-Age=0) |
| `ctx.text(body)` | Return text/plain response |
| `ctx.json(body)` | Return application/json response |
| `ctx.html(body)` | Return text/html response |
| `ctx.redirect(url)` | Return 302 redirect |

### Middleware

Middleware wraps handlers with a next-function pattern:

```milo
r.use(fn(ctx: &mut Context, next: (&mut Context) => Response): Response {
    let start = clock()
    let resp = next(ctx)
    let elapsed = clock() - start
    ctx.setHeader("X-Response-Time", elapsed.toString() + "ms")
    return resp
})
```

### Path Parameters and Wildcards

```milo
r.get("/users/:id/posts/:postId", handler)  // named params
r.get("/static/*", handler)                  // wildcard suffix
```

### Response Variants

`Text(string)`, `Html(string)`, `Json(string)`, `NotFound`, `Status(i32, string, string)`.

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

fn parseValue(s: &string, pos: &mut i64): Box<JsonValue> {
    skipWs(s, pos)
    let ch = s[pos]
    if ch == '"' { return parseString(s, pos) }
    if ch == '{' { return parseObject(s, pos) }
    if ch == '[' { return parseArray(s, pos) }
    // ... etc
}
```

---

## Complete Example: FizzBuzz

```milo
fn main(): i32 {
    for i in 1..21 {
        if i % 15 == 0 {
            print("FizzBuzz")
        } else if i % 3 == 0 {
            print("Fizz")
        } else if i % 5 == 0 {
            print("Buzz")
        } else {
            print(i)
        }
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

## String Interpolation (F-Strings)

Use `$"..."` for string interpolation. Expressions inside `{...}` are evaluated and converted to strings.

```milo
let name = "Milo"
let version: i32 = 1
let msg = $"Hello {name}, version {version}!"

let x: i32 = 10
let y: i32 = 20
print($"{x} + {y} = {x + y}")   // 10 + 20 = 30
```

F-strings desugar to `format()` calls. The `format()` builtin is also available directly:

```milo
let msg = format("Hello ", name, ", version ", version, "!")
```

---

## Operator Overloading

Implement the `Add`, `Sub`, `Mul`, `Div`, or `Eq` traits to overload operators on your types.

```milo
struct Vec2 { x: i32, y: i32 }

impl Add for Vec2 {
    fn add(self: &Self, other: &Self): Self {
        return Vec2 { x: self.x + other.x, y: self.y + other.y }
    }
}

impl Sub for Vec2 {
    fn sub(self: &Self, other: &Self): Self {
        return Vec2 { x: self.x - other.x, y: self.y - other.y }
    }
}

let a = Vec2 { x: 1, y: 2 }
let b = Vec2 { x: 3, y: 4 }
let c = a + b   // Vec2 { x: 4, y: 6 }
let d = a - b   // Vec2 { x: -2, y: -2 }
```

### Equality with @derive(Eq)

`@derive(Eq)` generates field-wise equality, enabling `==` and `!=`:

```milo
@derive(Eq)
struct Point { x: i32, y: i32 }

let a = Point { x: 1, y: 2 }
let b = Point { x: 1, y: 2 }
print(a == b)   // true
print(a != b)   // false
```

| Operator | Trait | Method |
|----------|-------|--------|
| `+` | `Add` | `add(self: &Self, other: &Self): Self` |
| `-` | `Sub` | `sub(self: &Self, other: &Self): Self` |
| `*` | `Mul` | `mul(self: &Self, other: &Self): Self` |
| `/` | `Div` | `div(self: &Self, other: &Self): Self` |
| `==` / `!=` | `Eq` | `eq(self: &Self, other: &Self): bool` |

---

## Concurrency

### Spawning Threads

Use `spawn()` with a `move` closure to run code on a new OS thread:

```milo
from "std/thread" import { spawn, threadJoin, Thread }

let t = spawn(move (): void => {
    print("hello from thread")
})!
threadJoin(t)!
```

Move closures are required for `spawn` — they heap-allocate captured variables so they're safe to send across threads.

```milo
from "std/thread" import { spawn, threadJoin, Thread }

var threads: Vec<Thread> = Vec.new()
for i in 0..4 {
    let id = i as i64
    let t = spawn(move (): void => {
        print($"thread {id}")
    })!
    threads.push(t)
}
for i in 0..4 {
    threadJoin(threads[i])!
}
```

### Thread Safety (Send / Sync)

The compiler enforces thread safety at compile time. `spawn()` requires all captured variables to implement `Send` — meaning they're safe to transfer across threads.

**Send types** (safe to move to another thread): all primitives, `string`, `Box<T>`, `Vec<T>`, `HashMap<K,V>`, structs/enums where all fields are Send, and any struct annotated with `@send`.

**Sync types** (safe to share via `&T` across threads): same rules, checked via `@sync`.

**Non-Send types**: raw pointers (`*T`), structs containing raw pointers (unless annotated).

```milo
// This compiles — i64 and string are Send
let msg = "hello"
let t = spawn(move (): void => { print(msg) })!

// This is a compile error — *u8 is not Send
var x: i32 = 42
unsafe {
    let p = (&x) as *u8
    let t = spawn(move (): void => {    // error: cannot send 'p' of type '*u8' across threads
        print(p as i64)
    })!
}
```

Use `@send` and `@sync` annotations to mark types with unsafe internals as thread-safe:

```milo
@send
@sync
struct MyHandle {
    _ptr: *u8,   // raw pointer, but we guarantee thread safety
}
```

The compiler error message tells you exactly which field breaks Send and suggests adding the annotation.

This prevents data races at compile time — if you can't send a raw pointer to another thread, you can't have unsynchronized shared mutable state.

### Parallel Blocks

Run multiple expressions concurrently and collect all results. Each branch runs on its own OS thread; the block completes when all branches finish.

```milo
fn expensiveA(): i64 { return 42 }
fn expensiveB(): i64 { return 99 }

parallel {
    let a = expensiveA()
    let b = expensiveB()
}
// a and b are in scope here
print(a + b)   // 141
```

Each branch is implicitly a move closure — captured variables are copied/moved into each branch. Variables bound in the `parallel` block are available in the enclosing scope after the block. Requires at least 2 bindings.

### Channels

Bounded FIFO channels for message passing between threads. Channel is a handle type — safe to capture in move closures without `unsafe`.

```milo
from "std/thread" import { spawn, threadJoin, Thread }
from "std/sync" import { channelNew, channelSend, channelRecv, channelDestroy }

let ch = channelNew(8)!

let t = spawn(move (): void => {
    channelSend(ch, 10)!
    channelSend(ch, 20)!
    channelSend(ch, 0)!   // sentinel
})!

while true {
    let val = channelRecv(ch)!
    if val == 0 { break }
    print(val)
}
threadJoin(t)!
channelDestroy(ch)
```

Non-blocking variants for polling:

```milo
from "std/sync" import { channelNew, channelTrySend, channelTryRecv, channelLen, channelDestroy }

let ch = channelNew(4)!
channelTrySend(ch, 42)       // returns true if sent, false if full
let val = channelTryRecv(ch)  // returns Option<i64> — None if empty
match val {
    Option.Some(v) => { print(v) }
    Option.None => { print("empty") }
}
print(channelLen(ch))         // current number of items
```

### Mutex

```milo
from "std/sync" import { mutexNew, mutexLock, mutexUnlock, withLock, mutexDestroy }

let m = mutexNew()!
mutexLock(m)!
// critical section
mutexUnlock(m)!
mutexDestroy(m)
```

Prefer `withLock` for scoped locking — guarantees unlock:

```milo
let m = mutexNew()!
var x: i64 = 0
withLock(m, (): void => {
    x = 42
})!
mutexDestroy(m)
```

### RwLock

Reader-writer lock: multiple concurrent readers OR one exclusive writer.

```milo
from "std/sync" import { rwLockNew, rwLockRead, rwLockWrite, rwLockUnlock, withReadLock, withWriteLock, rwLockDestroy }

let rw = rwLockNew()!

// Multiple readers allowed simultaneously
withReadLock(rw, (): void => {
    // read shared data
})!

// Exclusive writer
withWriteLock(rw, (): void => {
    // write shared data
})!

rwLockDestroy(rw)
```

### Atomics

Lock-free atomic types for cross-thread counters and flags. No mutex needed.

```milo
from "std/sync" import { atomicI64New, atomicI64Load, atomicI64Store, atomicI64Add, atomicI64Sub, atomicI64Cas, atomicI64Destroy }
from "std/sync" import { atomicBoolNew, atomicBoolLoad, atomicBoolStore, atomicBoolSwap, atomicBoolDestroy }

let counter = atomicI64New(0)
atomicI64Add(counter, 1)        // returns old value
print(atomicI64Load(counter))   // 1
atomicI64Store(counter, 42)
let old = atomicI64Cas(counter, 42, 99)  // compare-and-swap, returns old value
atomicI64Destroy(counter)

let flag = atomicBoolNew(false)
atomicBoolStore(flag, true)
let prev = atomicBoolSwap(flag, false)  // returns old value
atomicBoolDestroy(flag)
```

All atomic operations use sequential consistency (seq_cst). AtomicI64 and AtomicBool are `@send` + `@sync` — safe to share across threads.

### Thread API

| Function | Description |
|----------|-------------|
| `spawn(move () => {...})` | Spawn thread with move closure |
| `threadJoin(t)` | Wait for thread to finish |
| `threadSleep(ms)` | Sleep current thread (milliseconds) |
| `parallel { let a = ...; let b = ... }` | Run branches concurrently, join all |
| `channelNew(cap)` | Create bounded channel |
| `channelSend(ch, val)` | Send i64 value (blocks if full) |
| `channelRecv(ch)` | Receive i64 value (blocks if empty) |
| `channelTrySend(ch, val)` | Non-blocking send, returns `bool` |
| `channelTryRecv(ch)` | Non-blocking receive, returns `Option<i64>` |
| `channelLen(ch)` | Current items in channel |
| `channelDestroy(ch)` | Free channel resources |
| `mutexNew()` | Create mutex |
| `mutexLock(m)` / `mutexUnlock(m)` | Lock/unlock |
| `withLock(m, f)` | Scoped lock — runs closure, unlocks |
| `mutexDestroy(m)` | Free mutex |
| `rwLockNew()` | Create reader-writer lock |
| `rwLockRead(rw)` / `rwLockWrite(rw)` | Acquire read/write lock |
| `rwLockUnlock(rw)` | Release lock |
| `withReadLock(rw, f)` / `withWriteLock(rw, f)` | Scoped read/write lock |
| `rwLockDestroy(rw)` | Free rwlock |
| `atomicI64New(v)` / `atomicBoolNew(v)` | Create atomic |
| `atomicI64Load(a)` / `atomicBoolLoad(a)` | Atomic read |
| `atomicI64Store(a, v)` / `atomicBoolStore(a, v)` | Atomic write |
| `atomicI64Add(a, v)` / `atomicI64Sub(a, v)` | Atomic add/sub (returns old) |
| `atomicI64Cas(a, exp, des)` | Compare-and-swap (returns old) |
| `atomicBoolSwap(a, v)` | Atomic swap (returns old) |
| `atomicI64Destroy(a)` / `atomicBoolDestroy(a)` | Free atomic |

---

## Green Threads

Green threads are lightweight, user-space threads for high-concurrency I/O. You can run thousands concurrently with minimal memory overhead. There are no `async`/`await` keywords — the same code works in both OS threads and green threads.

### Spawning Green Threads

```milo
from "std/runtime" import { greenSpawn }

fn main(): i32 {
    greenSpawn(move (): void => {
        print("hello from green thread")
    })
    return 0
}
```

Green threads run cooperatively. The compiler automatically injects a scheduler drain at the end of `main` that runs all spawned green threads to completion.

### Cooperative Yielding

Green threads yield control explicitly with `schedulerYield()`:

```milo
from "std/runtime" import { greenSpawn, schedulerYield }

fn main(): i32 {
    greenSpawn(move (): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    greenSpawn(move (): void => {
        print("B1")
        schedulerYield()
        print("B2")
    })
    return 0
}
// Output: A1, B1, A2, B2
```

### I/O Waiting

Green threads can yield until a file descriptor is ready for reading or writing. This integrates with the platform event loop (kqueue on macOS, epoll on Linux):

```milo
from "std/runtime" import { greenSpawn, schedulerWaitRead, schedulerWaitWrite }
from "std/event" import { setNonblocking }

greenSpawn(move (): void => {
    setNonblocking(fd)
    // ... attempt read ...
    // if EAGAIN:
    schedulerWaitRead(fd)    // yields until fd is readable
    // ... retry read ...
})
```

### Transparent Async I/O

`tcpRecv` and `tcpSend` from `std/net` automatically detect when they're running inside a green thread. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

```milo
from "std/net" import { tcpConnect, tcpSend, tcpRecv }
from "std/runtime" import { greenSpawn }

greenSpawn(move (): void => {
    let stream = tcpConnect(ip, port)!
    tcpSend(stream, "hello")!      // yields if socket buffer full
    let data = tcpRecv(stream)!    // yields until data arrives
    print(data)
})
```

The same `tcpSend`/`tcpRecv` calls work identically outside green threads — they just block normally.

### Echo Server Example

A concurrent echo server handling multiple clients with green threads:

```milo
from "std/os" import { socket, bind, listen, accept, read, write, close, setsockopt, getsockname, ntohs }
from "std/platform" import { makeSockaddr, makeZeroedSockaddr, solSocket, soReuseaddr, getErrno, eagain }
from "std/event" import { setNonblocking }
from "std/runtime" import { greenSpawn, schedulerWaitRead }

fn main(): i32 {
    unsafe {
        let serverFd = socket(2, 1, 0)
        // ... bind, listen, setNonblocking(serverFd) ...

        greenSpawn(move (): void => {
            while true {
                var clientAddr = makeZeroedSockaddr()
                var addrlen: u32 = 16
                let clientFd = accept(serverFd, clientAddr, addrlen)
                if clientFd < 0 {
                    if getErrno() == eagain() {
                        schedulerWaitRead(serverFd)
                        continue
                    }
                    continue
                }
                setNonblocking(clientFd)
                let fd = clientFd
                greenSpawn(move (): void => {
                    var buf: [u8 ; 4096] = [0 ; 4096]
                    // read + echo back, yielding on EAGAIN
                    let n = read(fd, buf, 4096)
                    if n > 0 { write(fd, buf, n) }
                    close(fd)
                })
            }
        })
    }
    return 0
}
```

### Green Thread vs OS Thread

| | OS Thread (`spawn`) | Green Thread (`greenSpawn`) |
|---|---|---|
| Stack size | ~8MB | 64KB |
| Context switch | Kernel (microseconds) | Userspace (nanoseconds) |
| Max concurrent | ~hundreds | 10K+ |
| Best for | CPU-bound parallelism | I/O-bound concurrency |
| Preemptive | Yes | No (cooperative) |

### Green Thread API

| Function | Description |
|----------|-------------|
| `greenSpawn(move () => {...})` | Spawn a green thread |
| `schedulerYield()` | Yield to other green threads |
| `schedulerWaitRead(fd)` | Yield until fd is readable |
| `schedulerWaitWrite(fd)` | Yield until fd is writable |
| `schedulerCurrent()` | Get current task pointer (null if not in green thread) |
| `setNonblocking(fd)` | Set fd to non-blocking mode |

---

## Testing

### Assertions (std/testing)

```milo
from "std/testing" import { assert, assertEqual, assertStrEqual }

fn testArithmetic(): void {
    assertEqual(2 + 2, 4)
    assertEqual(10 * 3, 30)
    assert(true)
    assertMsg(1 > 0, "math is broken")
}

fn testStrings(): void {
    let s = "hello"
    assertStrEqual(s, "hello")
    assertEqual64(s.len, 5)
}
```

| Function | Description |
|----------|-------------|
| `assert(cond)` | Fail if false |
| `assertMsg(cond, msg)` | Fail with message |
| `assertEqual(got, expected)` | Compare i32 values |
| `assertEqual64(got, expected)` | Compare i64 values |
| `assertStrEqual(got, expected)` | Compare strings |
| `assertBool(got, expected)` | Compare bools |

### Test Runner

Test files use the `*_test.milo` naming convention. Test functions start with `test`.

```bash
# Run all *_test.milo files in current directory
milo test

# Run specific test file
milo test math_test.milo
```

Output:
```
math_test.milo
  testArithmetic ... ok
  testSubtraction ... ok
  testMultiplication ... ok

results: 3 passed, 0 failed, 3 total
```

---

## SQLite Database

```milo
from "std/sqlite" import { dbOpen, dbExec, dbQuery, dbStep, dbColumnInt, dbColumnText, dbFinalize, dbClose, dbLastInsertId }

let db = dbOpen("app.db")!

dbExec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")!
dbExec(db, "INSERT INTO users (name, age) VALUES ('Alice', 30)")!
dbExec(db, "INSERT INTO users (name, age) VALUES ('Bob', 25)")!

let stmt = dbQuery(db, "SELECT id, name, age FROM users ORDER BY id")!
while dbStep(stmt) {
    let name = dbColumnText(stmt, 1)
    let age = dbColumnInt(stmt, 2)
    print($"{name}, age {age}")
}
dbFinalize(stmt)
dbClose(db)
```

### Prepared Statements with Bindings

```milo
let stmt = dbQuery(db, "SELECT * FROM users WHERE age > ?")!
dbBindInt(stmt, 1, 25)!
while dbStep(stmt) {
    print(dbColumnText(stmt, 1))
}
dbFinalize(stmt)
```

| Function | Description |
|----------|-------------|
| `dbOpen(path)` | Open/create database |
| `dbClose(db)` | Close database |
| `dbExec(db, sql)` | Execute non-query SQL |
| `dbQuery(db, sql)` | Prepare query |
| `dbStep(stmt)` | Next row (true if available) |
| `dbColumnInt(stmt, col)` | Get i32 column |
| `dbColumnInt64(stmt, col)` | Get i64 column |
| `dbColumnFloat(stmt, col)` | Get f64 column |
| `dbColumnText(stmt, col)` | Get string column |
| `dbColumnIsNull(stmt, col)` | Check if NULL |
| `dbBindInt(stmt, idx, val)` | Bind i32 parameter |
| `dbBindText(stmt, idx, val)` | Bind string parameter |
| `dbFinalize(stmt)` | Free statement |
| `dbLastInsertId(db)` | Last inserted rowid |
| `dbReset(stmt)` | Reset for re-execution |

---

## Standard Library Extras

### Terminal Colors (std/color)

```milo
from "std/color" import { red, green, blue, bold }

print(red("error: something failed"))
print(green("success!"))
print(bold(blue("important")))
print(yellow("warning: "), dim("details"))
```

Available: `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, `bold`, `dim`, `italic`, `underline`, `strikethrough`, `bgRed`, `bgGreen`, `bgYellow`, `bgBlue`.

### UUID Generation (std/uuid)

```milo
from "std/uuid" import { uuidV4 }

let id = uuidV4()   // "550e8400-e29b-41d4-a716-446655440000"
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
| Embed file | `embedFile("path")` |
| JSON serialize | `jsonStringify(struct_val)` |
| String slice | `s[start..end]` |
| Number to string | `n.toString()` |
| Bitwise | `& \| ^ << >> ~` |
| Hex / binary literal | `0xFF`, `0b1010` |
