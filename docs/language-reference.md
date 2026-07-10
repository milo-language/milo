# The Milo Language Guide

A memory-safe systems language with simple syntax inspired by TypeScript, Python, and Rust. Compiles to native code via LLVM.

## Getting Started

```bash
# Install prerequisites: Bun (https://bun.sh) and LLVM/Clang

# Compile and run
bun run src/main.ts build examples/hello.milo -o hello
./hello

# Emit LLVM IR (useful for understanding what the compiler does)
bun run src/main.ts emit-ir examples/hello.milo

# Search the standard library (auto-discovered from std/**/*.milo)
bun run src/main.ts api time                  # ranked signature search by name + doc
bun run src/main.ts api --module std/datetime # dump one module's full API
```

Reach for `milo api` before hand-writing something the stdlib already provides.

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

```milo error
let x: i8 = 200              // error: integer literal 200 overflows i8 (range -128..127)
let y: i32 = 2147483647 + 1  // error: constant expression overflows i32
```

**Runtime (debug builds)** — arithmetic traps on overflow with source location:

```milo
let x: i32 = 2147483647
let y = x + 1     // runtime error: integer overflow at main.milo:2
```

Build with `--debug` to enable overflow traps. Default (`-O2`) and `--release` (`-O3`) builds use wrapping arithmetic for performance. Add `-g` for DWARF debug info (source-level `lldb`/`gdb` stepping and variable inspection) — see `docs/site/getting-started/debugging.md`.

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

Note: range-type bounds are **inclusive** on both ends — `i32(0..50000)` accepts 0 and 50000. This differs from `for` loop ranges, where `0..n` excludes `n`.

```milo
type Altitude = i32(0..50000)
type Temperature = i32(-100..100)

let alt: Altitude = 30000         // ok
let top: Altitude = 50000         // ok — bounds are inclusive
```

```milo error
type Altitude = i32(0..50000)
let bad: Altitude = 60000         // compile error: value 60000 is out of range
```

Dynamic values are checked at runtime:

```milo
type Altitude = i32(0..50000)

fn readSensor(): i32 {
    return 30000
}

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
let a: i32 = 0b1100
let b: i32 = 0b1010
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
    print("hello, ", name)
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
| `jsonStringify(val)` | Serialize a flat struct (scalar fields only) to JSON string |
| `embedFile(path)` | Embed file contents as string at compile time |

### Contracts

Functions can declare preconditions (`requires`), postconditions (`ensures`), and loop invariants (`invariant`). These are type-checked at compile time — each clause must be a `bool` expression. In `ensures` clauses, `result` refers to the return value.

In debug builds (`--debug`), contracts are asserted at runtime: `requires` at function entry, `ensures` at every return, and `invariant` before each loop condition evaluation (loop entry, every iteration, and exit). A violation prints `runtime error: <kind> clause violated at file:line` and exits with code 1. Release builds compile contracts out entirely. Call-site `requires` violations with compile-time-constant arguments are still rejected at compile time.

```milo
fn clamp(value: i64, lo: i64, hi: i64): i64
  requires lo <= hi
  ensures result >= lo && result <= hi
{
    if value < lo { return lo }
    if value > hi { return hi }
    return value
}
```

Loop invariants go between the `while` condition and the loop body:

```milo
let n: i64 = 10
var total: i64 = 0
var i: i64 = 1
while i <= n
  invariant total >= 0
  invariant i >= 1
{
    total = total + i
    i = i + 1
}
```

Use `milo verify file.milo` to generate SMT-LIB2 verification conditions for Z3/CVC5. Use `milo safety file.milo --safety=do178c-a` to check against domain-specific safety profiles (DO-178C, ISO 26262, NASA, IEC 61508, IEC 62304).

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
s.indexOf("World")      // 7 (-1 if not found)
s.lastIndexOf("l")      // 10 (-1 if not found)
s.replace("World", "Milo")  // "Hello, Milo!"
s.padStart(15, " ")     // "  Hello, World!"
s.padEnd(15, ".")       // "Hello, World!.."
s.isEmpty()             // false
s.charAt(0)             // "H"
s.reverse()             // "!dlroW ,olleH"
s.replaceFirst("l", "L") // "HeLlo, World!"
s.repeat(3)             // "Hello, World!Hello, World!Hello, World!"
"42".parseInt()         // 42 (i64)
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
print(p.x)

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
print(d.getAge())
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
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

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
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
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

Every fallible call site must be explicitly handled — `!`, `?`, or `??`. This makes error paths visible in source code, unlike languages where exceptions can silently propagate.

```milo
fn unwrapIt(opt: i32?): i32 {
    return opt!          // unwrap — panic if None (with source location)
}

fn orDefault(opt: i32?): i32 {
    return opt ?? 0      // default — use 0 if None
}

fn doubled(opt: i32?): i32? {
    let v = opt?         // propagate — return None from current function if None
    return Option.Some(v * 2)
}
```

On panic, `!` prints the source location and error message, then exits:
```
error at 12:38: connection refused
```

These also work with `Result`. Writing `Result<T>` with one type argument defaults the error type to `string` — `Result<i32>` is `Result<i32, string>`:

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
    print("got ", val)
}
```

---

## Arrays

Fixed-size, stack-allocated, bounds-checked.

```milo
let arr = [10, 20, 30]
print(arr[0])
print(arr.len)

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

print(v[0])           // bounds-checked
print(v.len)

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
nums.each((n: &i32) => print(n))             // side effects
nums.enumerate((i: i64, n: &i32) => {              // index + element
    print(i.toString() + ": " + n.toString())
})

let words: Vec<string> = ["hello", "world"]
print(words.join(", "))                             // "hello, world"
words.contains("hello")                             // true
words.isEmpty()                                     // false
```

### Mutating methods

```milo
struct User { name: string, age: i32 }

var v: Vec<i32> = [3, 1, 2]
v.sort()                  // [1, 2, 3] — in-place, ascending
v.reverse()               // [3, 2, 1] — in-place

// custom comparator: negative = a first, positive = b first
var users: Vec<User> = [
    User { name: "Alice", age: 30 },
    User { name: "Bob", age: 25 },
]
users.sortBy((a: &User, b: &User) => a.age - b.age)  // full control

// key extractor: just return the field to sort on
users.sortByKey((u: &User) => u.age)                  // simpler
users.sortByKey((u: &User) => u.name)                 // works with strings too
```

`sort` works on Vec of int, float, string, or bool. `sortBy` and `sortByKey` work on any type. All require `var`.

---

## HashMap\<K, V\>

Open-addressing hash table with FNV-1a hashing.

```milo
var m: HashMap<string, i32> = HashMap.new()
m.insert("hello", 42)
m.insert("world", 99)

print(m.len)

if m.contains("hello") {
    print("found it")
}

let val = m.get("hello")       // returns Option<i32>
if let Option.Some(v) = val {
    print("value: ", v)
}

let v = m.getOrDefault("hello", 0)  // returns i32 directly (0 if missing)

m.remove("hello")
```

---

## Heap\<T\> — Heap Allocation

`Heap<T>` is a single-owner heap pointer. Useful for recursive data structures.

```milo
// Recursive enum — must heap-allocate the recursive case
enum Tree {
    Node(Heap<Tree>, Heap<Tree>),
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
    Heap(Tree.Leaf(1)),
    Heap(Tree.Leaf(2))
)
print(sum(tree))   // 3
```

Heap auto-frees when it goes out of scope.

---

## Ownership and Move Semantics

Values have a single owner. Assignment transfers ownership.

```milo
let a = "hello"
let b = a          // a is moved into b
// a is now invalid — using it here is a compile error
print(b)         // fine
```

This applies to structs, enums, strings, Vec, HashMap, and Heap.
Primitive types (`i32`, `bool`, `f64`, etc.) are copied, not moved.

### Move in Branches

The compiler tracks moves through control flow:

```milo
struct Point { x: i32, y: i32 }

fn consume(p: Point): void {
    print(p.x)
}

let condition = true
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

Two things to be aware of:

- **Borrowing is implicit at call sites.** `double(n)` mut-borrows `n` and `consume(s)` moves `s`, but the calls look identical — the function signature, not the call site, tells you which happens. The compiler still rejects any use-after-move, so mistakes are compile errors, not bugs.
- **Assignment through `&mut` has no deref sigil.** Inside `double`, `x = x * 2` writes through the reference to the caller's variable. (Reassigning a `&string` slice *local*, by contrast, just rebinds the view — see [Strings](#strings).)

**What you can't do:**

```milo error
fn bad(s: &string): &string {     // COMPILE ERROR: can't return a reference
    return s
}
```

```milo error
struct Bad { r: &string }         // COMPILE ERROR: can't store a reference
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
trait Hash {
    fn hash(self: &Self): i64
}

fn process<T: Eq + Hash>(a: &T, b: &T): i64 {
    if a.eq(b) {
        return a.hash()
    }
    return b.hash()
}
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

## Interfaces (Runtime Polymorphism)

Interfaces enable dynamic dispatch via structural typing. Any type with matching methods satisfies an interface — no explicit declaration needed.

```milo
interface Greeter {
    fn greet(self: &Self): string
}

struct Dog { name: string }
impl Dog {
    fn greet(self: &Self): string {
        return "woof from " + self.name
    }
}

struct Cat {}
impl Cat {
    fn greet(self: &Self): string {
        return "meow"
    }
}

fn sayHello(g: &Greeter) {
    print(g.greet())
}

fn main(): i32 {
    let d = Dog { name: "Rex" }
    let c = Cat {}
    sayHello(d)  // woof from Rex
    sayHello(c)  // meow
    return 0
}
```

### How It Works

- Interface values are fat pointers: `{ data_ptr, itable_ptr }`
- The compiler generates an itable (interface table) for each concrete type / interface pair
- Method dispatch is an indirect call through the itable — like Go, unlike C++ vtables embedded in objects
- Structural satisfaction: if a type has all required methods with matching signatures, it satisfies the interface

### Interfaces vs Traits

| | Traits | Interfaces |
|---|---|---|
| Dispatch | Static (monomorphization) | Dynamic (vtable/itable) |
| Typing | Nominal (`impl Trait for Type`) | Structural (methods match → satisfies) |
| Use case | Generic bounds, operator overloading, `@derive` | Runtime polymorphism, heterogeneous collections |

Both inherent methods (`impl Type`) and trait methods (`impl Trait for Type`) count toward interface satisfaction.

### Restrictions (v1)

- Interface methods must take `self: &Self` (by reference, not by value)
- No generic parameters on interfaces
- No interface inheritance
- No downcasting from `&Interface` to `&ConcreteType`

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

When a closure is passed to a function that takes an owned `Fn` parameter (not `&Fn`), the compiler automatically infers `move` — no keyword needed. Explicit `move` is still supported for clarity or when needed (e.g., returning a closure from a function).

```milo
fn makeAdder(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x + n
    }
}

fn makeMultiplier(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x * n
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

fn makeMultiplier(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x * n
    }
}

let h = Handler { name: "doubler", callback: makeMultiplier(2) }
let cb = h.callback
print(cb(10))   // 20
```

---

## Control Flow

```milo
let x: i32 = 5
let n: i32 = 42

// if/else
if x > 0 {
    print("positive")
} else if x == 0 {
    print("zero")
} else {
    print("negative")
}

// if-else expression — both branches must have same type
let label = if x > 0 { "positive" } else { "negative" }

// else-if chains work too
let size = if n < 10 { "small" } else if n < 100 { "medium" } else { "big" }

// while
var i: i32 = 0
while i < 10 {
    if i == 5 { break }
    if i % 2 == 0 {
        i = i + 1
        continue
    }
    print(i)
    i = i + 1
}
```

---

## Modules and Imports

```milo
// Import specific items (required — no wildcard imports)
from "std/http" import { Context, Response, Router, serveRouter }
```

```milo skip
// Import from a relative path (resolved against the importing file's directory)
from "lib/math" import { add, multiply }
```

All imports must be explicit — list exactly which symbols you use. No `import *` or bare `import "path"`. The LSP provides autocomplete for both module paths and symbols.

---

## C FFI

### Extern Functions

Declare external C functions with `extern`:

```milo
extern fn puts(s: *u8): i32
extern fn printf(fmt: *u8, ...): i32
extern fn malloc(size: u64): *u8
```

### Safe vs Unsafe Extern Calls

The compiler determines whether an extern call needs `unsafe` based on the argument types and return type.

**Safe** (no `unsafe` needed) when:
- All pointer params receive auto-coerced args: `string`→`*u8`, `[T;N]`→`*T`, matching `*T`→`*T`
- Function-typed params receive a matching Milo function
- By-value `extern struct` args (exact type match) — a POD bit-copy with no provenance
- Return type is scalar, `void`, or a by-value `extern struct`

**Unsafe** when:
- Return type is a pointer (`*T`) — unknown provenance
- A param takes a raw `*T` that isn't from auto-coercion

```milo
extern fn puts(s: *u8): i32
extern fn write(fd: i32, buf: *u8, len: i64): i64
extern fn malloc(size: u64): *u8

fn main(): i32 {
    puts("Hello from C!")             // safe — string auto-coerces, returns i32
    write(1, "output", 6)             // safe — string auto-coerces, returns i64
    unsafe { let p = malloc(64) }     // unsafe — returns *u8
    return 0
}
```

### Unsafe Blocks

`unsafe { }` is required for operations the compiler can't verify:

```milo
extern fn malloc(size: i64): *u8

var x: i32 = 5
unsafe {
    let p = malloc(64)        // extern returning pointer
    p[0] = 42 as u8           // pointer indexing
    let val = *p              // pointer deref
    let q = (&x) as *u8      // address-of cast
}
```

Exception: `0 as *T` (null pointer literal) does not require `unsafe`.

### string.cstr()

Returns the string's `*u8` data pointer without `unsafe`. The string remains alive in the caller's scope, so the pointer is valid.

```milo
let msg = "hello"
let ptr = msg.cstr()               // *u8, no unsafe needed
extern fn strlen(s: *u8): i64
let len = strlen(ptr)              // safe — *u8 arg matches *u8 param
```

### Opaque Foreign Types

`extern type` declares a type with no known size or layout. It can only exist behind a pointer:

```milo
extern type sqlite3
extern type sqlite3_stmt

extern fn sqlite3_open(path: *u8, db: **sqlite3): i32
extern fn sqlite3_close(db: *sqlite3): i32
```

The compiler rejects using an opaque type by value — only `*sqlite3` is valid. `*sqlite3` is a distinct type from `*sqlite3_stmt` and `*u8`, preventing handle mixups at compile time.

```milo
// null pointer to opaque type — always safe
let db: *sqlite3 = 0 as *sqlite3
```

### Extern Structs

`extern struct` declares a C-layout struct. The compiler knows field offsets and generates GEP instructions for field access:

```milo
extern struct SockAddrIn {
    sin_family: u16,
    sin_port: u16,
    sin_addr: u32,
    sin_zero: [u8; 8],
}
```

Field access through a pointer auto-derefs (requires `unsafe` for the pointer deref):

```milo
extern fn malloc(size: i64): *u8
extern fn htons(x: u16): u16

struct SockAddrIn {
    sin_family: u16,
    sin_port: u16,
    sin_addr: u32,
}

unsafe {
    let addr: *SockAddrIn = malloc(16) as *SockAddrIn
    addr.sin_family = 2       // GEP + store, no byte arithmetic
    addr.sin_port = htons(80)
    let family = addr.sin_family
}
```

### Passing Structs by Value

An `extern struct` may cross the C ABI **by value** — as an argument and as a return
value. The compiler classifies each struct per the platform ABI (AAPCS64 on ARM64,
System V on x86-64): small structs are coerced into registers, homogeneous-float
structs go in SIMD/SSE registers, larger ones pass indirectly (`byval`) and return via
a hidden pointer (`sret`). The lowering matches what clang emits, so calls interoperate
with real C libraries.

```milo
extern struct Vec2 {
    x: f64,
    y: f64,
}

extern fn vec2_add(a: Vec2, b: Vec2): Vec2

fn main(): i32 {
    let a = Vec2 { x: 1.0, y: 2.0 }
    let b = Vec2 { x: 3.0, y: 4.0 }
    let c = vec2_add(a, b)        // safe — by-value extern struct, no unsafe needed
    print(c.x)
    return 0
}
```

**Rules and limits:**

- Only an `extern struct` may cross by value. A regular struct passed by value to an
  extern function is a compile error — declare it `extern struct`, or pass it by
  reference (`&T`).
- Extern-struct fields must be C-representable: integers, floats, `bool`, pointers
  (`*T`), nested extern structs, and fixed arrays of those. `string`, `Vec`, enums, and
  other managed types are rejected — every extern struct is plain-old-data (Copy, no
  drop glue), so passing one leaves the original usable.
- Not supported (compile error, pass `&T` instead): a struct in a variadic (`...`)
  position, an `enum` crossing the ABI, a function-pointer parameter that itself passes
  a struct by value, and struct-by-value on bare-metal ARM (AAPCS32).

### Generating C Headers

`build-lib` writes a companion C header next to the archive so C code can call into a
Milo library:

```bash
milo build-lib mathlib.milo -o libmathlib.a   # also writes libmathlib.h
milo emit-obj mathlib.milo --emit-header       # writes mathlib.h next to mathlib.o
```

The header declares the exported functions and the extern structs (opaque `extern type`
declarations become forward `typedef struct X X;`). Anything without a stable C
spelling — a `Vec`/`String`/enum in a signature, or (until define-side ABI lowering
lands) an exported function that passes or returns a struct by value — is emitted as a
`/* skipped: ... */` comment so the header stays valid and the gap stays visible.

### Typed Function Pointers in Extern Decls

Extern functions can declare function-typed parameters. Passing a matching Milo function requires no cast:

```milo
extern fn qsort(base: *u8, num: i64, size: i64, cmp: (*u8, *u8) => i32): void

fn cmpI32(a: *u8, b: *u8): i32 {
    unsafe {
        let va = *(a as *i32)
        let vb = *(b as *i32)
        return va - vb
    }
}

fn main(): i32 {
    var arr: [i32; 5] = [50, 10, 99, 30, 70]
    unsafe { qsort((&arr[0]) as *u8, 5, 4, cmpI32) }   // cmpI32 passed directly
    return 0
}
```

---

## JSON Serialization

`jsonStringify` is a built-in that serializes a flat struct to a JSON string. Supported field types: `string` (escaped automatically), integers, floats, and `bool` — anything else is a compile error:

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

For nested objects, arrays, or JSON built up dynamically, use the fluent builders in `std/json`:

```milo
from "std/json" import { jsonObj, jsonArr }

let doc = jsonObj()
    .str("type", "capabilities")
    .int("seq", 3)
    .obj("inner", jsonObj().bool("ok", true))
    .arr("tags", jsonArr().str("a").str("b"))
    .build()
// {"type":"capabilities","seq":3,"inner":{"ok":true},"tags":["a","b"]}
```

Builder methods: `.str/.int/.float/.bool/.nil/.obj/.arr/.val` (chainable, consume and return the builder; string values are escaped). `jsonArr()` has the same set minus keys.

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

    r.get("/", (ctx: &mut Context) => {
        return ctx.text("Hello from Milo!")
    })

    r.get("/users/:id", (ctx: &mut Context) => {
        let id = ctx.param("id")
        ctx.setHeader("X-User-Id", id.clone())
        return ctx.json($"\{\"id\": \"{id}\"}")
    })

    r.get("/search", (ctx: &mut Context) => {
        let q = ctx.query("q")
        return ctx.text($"results for: {q}")
    })

    let _ = serveRouter(8080, r)
    return 0
}
```

### Route Methods

```milo
from "std/http" import { Context, Response, Router }

fn handleReq(ctx: &mut Context): Response {
    return ctx.text("ok")
}

var r: Router = Router.new()
r.get("/things", handleReq)      // GET
r.post("/things", handleReq)     // POST
r.put("/things", handleReq)      // PUT
r.delete("/things", handleReq)   // DELETE
r.all("/things", handleReq)      // any method
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
from "std/http" import { Context, Response, Router }
from "std/time" import { now, since, durationMillis }

fn timing(ctx: &mut Context, next: (&mut Context) => Response): Response {
    let start = now()
    let resp = next(ctx)
    let ms = durationMillis(since(start))
    ctx.setHeader("X-Response-Time", ms.toString() + "ms")
    return resp
}

var r: Router = Router.new()
r.use(timing)
```

### Path Parameters and Wildcards

```milo
from "std/http" import { Context, Response, Router }

fn handleReq(ctx: &mut Context): Response {
    return ctx.text("ok")
}

var r: Router = Router.new()
r.get("/users/:id/posts/:postId", handleReq)  // named params
r.get("/static/*", handleReq)                  // wildcard suffix
```

### Response Variants

`Text(string)`, `Html(string)`, `Json(string)`, `NotFound`, `Status(i32, string, string)`.

---

## Complete Example: JSON Parser

This example exercises enums with complex payloads, Heap, Vec, structs, recursion, and string operations. See [`examples/json_parser.milo`](../examples/json_parser.milo) for the full source.

```milo
struct JsonKV {
    key: string,
    value: Heap<JsonValue>,
}

enum JsonValue {
    Null,
    Bool(bool),
    Number(i64),
    Str(string),
    Array(Vec<Heap<JsonValue>>),
    Object(Vec<JsonKV>),
}

fn skipWs(s: &string, pos: &mut i64): void {
    while pos < s.len && s[pos] == ' ' { pos = pos + 1 }
}

fn parseString(s: &string, pos: &mut i64): Heap<JsonValue> { return Heap(JsonValue.Null) }
fn parseObject(s: &string, pos: &mut i64): Heap<JsonValue> { return Heap(JsonValue.Null) }
fn parseArray(s: &string, pos: &mut i64): Heap<JsonValue> { return Heap(JsonValue.Null) }

fn parseValue(s: &string, pos: &mut i64): Heap<JsonValue> {
    skipWs(s, pos)
    let ch = s[pos]
    if ch == '"' { return parseString(s, pos) }
    if ch == '{' { return parseObject(s, pos) }
    if ch == '[' { return parseArray(s, pos) }
    return Heap(JsonValue.Null)  // ... numbers, bools, null
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
    Node(Heap<Tree>, Heap<Tree>),
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
        Heap(Tree.Node(Heap(Tree.Leaf(1)), Heap(Tree.Leaf(2)))),
        Heap(Tree.Node(Heap(Tree.Leaf(3)), Heap(Tree.Leaf(4))))
    )
    print($"sum: {sum(tree)}")   // sum: 10
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
let name = "milo"
let version = "0.1"
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

Milo's primary concurrency model is **green tasks**: `Task.spawn` runs a closure on a cooperative, single-threaded scheduler. Blocking I/O and channel operations automatically yield to other tasks — there is no async/await coloring and no event loop to run by hand. `Promise<T>`, `Channel`, `select`, and `WaitGroup` all park the *task* (not the OS thread), so they compose freely. OS `Thread`/`Mutex`/`RwLock` remain for CPU-bound parallelism and blocking FFI (see [Escape hatch: OS threads](#escape-hatch-os-threads)).

### Choosing a tool

| Need | Use |
|------|-----|
| One-shot result off the main flow | `Promise(fn)` → `.await()!`; fan-out with `Promise.all`, first-wins with `Promise.race` |
| Stream of values over time | `Channel<T>` — producer `send`s + `close()`s, consumer `for val in ch` |
| Fleet of fire-and-forget workers | `Task.spawn` + `WaitGroup` |
| Wait on first-of-many sources | `std/select` |
| CPU-bound work or blocking FFI | `Thread.spawn`, or a `parallel` block for a fixed few |
| Shared mutable state across threads | `Mutex.withLock` / `RwLock`; plain counters and flags → atomics |

Most programs need only the first row. `Promise` is the familiar promise/await model with no event loop and no function coloring, and `await()` frees the promise's resources itself — there is nothing to `destroy()`.

### Tasks

```milo
from "std/runtime" import { Task }

let t = Task.spawn(move (): void => {
    print("hello from a task")
})
t.join()   // block until the task finishes
```

**Exit semantics are Go's:** when `main` returns, the process exits and any tasks still running are abandoned. Waiting is always explicit — nothing drains outstanding tasks for you. Join a specific task, or use a `WaitGroup` / `Channel` / `Promise`:

```milo
from "std/runtime" import { Task }
from "std/sync" import { WaitGroup }

let wg = WaitGroup.new()
for i in 0..8 {
    wg.add(1)
    let n = i
    Task.spawn(move (): void => {
        print(n.toString())
        wg.done()
    })
}
wg.wait()          // returns once all 8 have called done()
wg.destroy()
```

`Task.join()` must be called before the joined task can complete (i.e. right after `spawn`, before you yield or drive the scheduler) — the cooperative scheduler guarantees the registration lands first. A server that spawns an accept loop and should run forever can drive the scheduler explicitly with `schedulerRunToCompletion()` (runs every spawned task to quiescence, then tears the scheduler down):

```milo
from "std/runtime" import { Task, schedulerRunToCompletion }

fn acceptLoop(fd: i32): void {
    // accept connections and spawn a handler task per client, forever
}

Task.spawn(move (): void => { acceptLoop(0) })   // never returns in a real server
schedulerRunToCompletion()                       // main blocks here
```

### Escape hatch: OS threads

`Thread.spawn()` runs code on a real OS thread — reach for it for CPU-bound parallelism or FFI that must block, not for ordinary concurrency (a blocking `Thread` call parks the whole OS thread, whereas a `Task` yields). The compiler automatically infers `move` for the closure — captured variables are copied into a heap-allocated environment so they're safe to send across threads:

```milo
from "std/thread" import { Thread }

let t = Thread.spawn((): void => {
    print("hello from thread")
})!
t.join()!
```

```milo
from "std/thread" import { Thread }

var threads: Vec<Thread> = Vec.new()
for i in 0..4 {
    let id = i as i64
    let t = Thread.spawn((): void => {
        print($"thread {id}")
    })!
    threads.push(t)
}
for i in 0..4 {
    threads[i].join()!
}
```

### Thread Safety (Send / Sync)

The compiler enforces thread safety at compile time. `Thread.spawn()` requires all captured variables to implement `Send` — meaning they're safe to transfer across threads.

**Send types** (safe to move to another thread): all primitives, `string`, `Heap<T>`, `Vec<T>`, `HashMap<K,V>`, structs/enums where all fields are Send, and any struct annotated with `@send`.

**Sync types** (safe to share via `&T` across threads): same rules, checked via `@sync`.

**Non-Send types**: raw pointers (`*T`), structs containing raw pointers (unless annotated).

```milo error
from "std/thread" import { Thread }

// This compiles — i64 and string are Send
let msg = "hello"
let t = Thread.spawn((): void => { print(msg) })!

// This is a compile error — *u8 is not Send
var x: i32 = 42
unsafe {
    let p = (&x) as *u8
    let t2 = Thread.spawn((): void => {    // error: cannot send 'p' of type '*u8' across threads
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

### Promises

For most concurrent work, reach for `Promise<T>`. It runs a function on a green thread and returns the result. `Promise(fn)` is shorthand for `Promise<T>.run(fn)` with the type inferred from the closure's return type:

```milo
from "std/runtime" import { Promise }

fn expensiveComputation(): i64 {
    return 42
}

let p = Promise((): i64 => {
    return expensiveComputation()
})
let result = p.await()!
```

`Promise.all()` runs multiple tasks and collects all results. `Promise.race()` returns whichever finishes first:

```milo
from "std/runtime" import { Promise }

fn fetchA(): i64 { return 1 }
fn fetchB(): i64 { return 2 }

var tasks: Vec<Promise<i64>> = Vec.new()
tasks.push(Promise((): i64 => { return fetchA() }))
tasks.push(Promise((): i64 => { return fetchB() }))

let results = Promise.all(tasks).await()!   // [resultA, resultB]
```

Promises run on green threads with cooperative scheduling — no async/await coloring, no event loop. Blocking I/O automatically yields to other tasks.

### Channels

Bounded FIFO channels for streaming values between threads. Use channels when a producer sends many values over time — for one-shot results, prefer Promise.

Channel is a handle type — safe to capture in move closures without `unsafe`.

```milo
from "std/thread" import { Thread }
from "std/sync" import { Channel }

var ch = Channel<i64>.new(8)!

let t = Thread.spawn(move (): void => {
    ch.send(10)!
    ch.send(20)!
    ch.close()
})!

for val in ch {
    print(val)
}
t.join()!
ch.destroy()
```

Call `close()` to signal no more values will be sent. Remaining items are delivered before iteration ends. `send()` on a closed channel returns `Result.Err`.

Non-blocking variants for polling:

```milo
from "std/sync" import { Channel }

let ch = Channel<i64>.new(4)!
ch.trySend(42)               // returns true if sent, false if full
let val = ch.tryRecv()        // returns Option<i64> — None if empty
match val {
    Option.Some(v) => { print(v) }
    Option.None => { print("empty") }
}
print(ch.len())               // current number of items
```

### Mutex

```milo
from "std/sync" import { Mutex }

let m = Mutex.new()!
m.lock()!
// critical section
m.unlock()!
m.destroy()
```

Prefer `withLock` for scoped locking — guarantees unlock:

```milo
from "std/sync" import { Mutex }

let m = Mutex.new()!
var x: i64 = 0
m.withLock((): void => {
    x = 42
})!
m.destroy()
```

### RwLock

Reader-writer lock: multiple concurrent readers OR one exclusive writer.

```milo
from "std/sync" import { RwLock }

let rw = RwLock.new()!

// Multiple readers allowed simultaneously
rw.withReadLock((): void => {
    // read shared data
})!

// Exclusive writer
rw.withWriteLock((): void => {
    // write shared data
})!

rw.destroy()
```

### Atomics

Lock-free atomic types for cross-thread counters and flags. No mutex needed.

```milo
from "std/sync" import { AtomicI64, AtomicBool }

let counter = AtomicI64.new(0)
counter.add(1)                  // returns old value
print(counter.load())           // 1
counter.store(42)
let old = counter.cas(42, 99)   // compare-and-swap, returns old value
counter.destroy()

let flag = AtomicBool.new(false)
flag.store(true)
let prev = flag.swap(false)     // returns old value
flag.destroy()
```

All atomic operations use sequential consistency (seq_cst). AtomicI64 and AtomicBool are `@send` + `@sync` — safe to share across threads.

### Pitfalls

1. **`main` returning abandons running tasks.** Exit semantics are Go's — wait explicitly (`join`, `WaitGroup`, `Promise`, channel) or the work silently dies with the process. `exit(code)` terminates immediately from anywhere.
2. **Call `Task.join()` immediately after `spawn`.** The registration must land before the task can complete; joining after you've yielded or blocked elsewhere is a lost wakeup.
3. **The green scheduler is single-threaded and cooperative.** A task that spins on CPU or calls blocking FFI starves every other task — nothing preempts it. Move that work to a `Thread`; long compute loops that must stay on a task should `schedulerYield()` periodically.
4. **Same call, opposite cost per tier.** `ch.recv()` in a task parks just the task; on a `Thread` it parks the whole OS thread. Default to tasks — threads only for CPU parallelism and blocking FFI.
5. **Sync primitives are shared handles with manual lifecycle.** Copying a `Channel`/`Mutex`/`WaitGroup` shares the underlying object, so there is no automatic drop — call `.destroy()` exactly once, after every user is done. Prefer `withLock`/`withReadLock` over raw `lock`/`unlock` (unlock guaranteed on every path).
6. **Channels must be `close()`d** or the consumer's `for val in ch` never ends. `send` on a closed channel returns `Result.Err`, not a panic. Bounded `send` blocking when full is backpressure, not a bug — poll with `trySend`/`tryRecv`.
7. **Move closures capture copies.** Mutating a captured `var` inside a task or thread is invisible outside. Communicate results through a `Channel`/`Promise`, or share through a `Mutex`/atomic — never through captured locals.

### Thread API

| Function | Description |
|----------|-------------|
| `Thread.spawn(move () => {...})` | Spawn thread with move closure |
| `t.join()` | Wait for thread to finish |
| `Thread.sleep(ms)` | Sleep current thread (milliseconds) |
| `parallel { let a = ...; let b = ... }` | Run branches concurrently, join all |
| `Channel.new(cap)` | Create bounded channel |
| `ch.send(val)` | Send i64 value (blocks if full) |
| `ch.recv()` | Receive i64 value (blocks if empty) |
| `ch.trySend(val)` | Non-blocking send, returns `bool` |
| `ch.tryRecv()` | Non-blocking receive, returns `Option<i64>` |
| `ch.len()` | Current items in channel |
| `ch.destroy()` | Free channel resources |
| `Mutex.new()` | Create mutex |
| `m.lock()` / `m.unlock()` | Lock/unlock |
| `m.withLock(f)` | Scoped lock — runs closure, unlocks |
| `m.destroy()` | Free mutex |
| `RwLock.new()` | Create reader-writer lock |
| `r.read()` / `r.write()` | Acquire read/write lock |
| `r.unlock()` | Release lock |
| `r.withReadLock(f)` / `r.withWriteLock(f)` | Scoped read/write lock |
| `r.destroy()` | Free rwlock |
| `AtomicI64.new(v)` / `AtomicBool.new(v)` | Create atomic |
| `a.load()` | Atomic read |
| `a.store(v)` | Atomic write |
| `a.add(v)` / `a.sub(v)` | Atomic add/sub (returns old) |
| `a.cas(exp, des)` | Compare-and-swap (returns old) |
| `a.swap(v)` | Atomic swap (returns old) |
| `a.destroy()` | Free atomic |

---

## Green Threads

Green threads are lightweight, user-space threads for high-concurrency I/O. You can run thousands concurrently with minimal memory overhead. There are no `async`/`await` keywords — the same code works in both OS threads and green threads.

### Spawning Green Threads

```milo
from "std/runtime" import { Task }

fn main(): i32 {
    Task.spawn(move (): void => {
        print("hello from green thread")
    })
    return 0
}
```

Green threads run cooperatively. When `main` returns, the process exits and any tasks still running are abandoned — nothing waits for them. Waiting is always explicit: `t.join()`, a `WaitGroup`/`Channel`/`Promise`, or `schedulerRunToCompletion()` for a run-forever server (see [Concurrency](#concurrency)).

### Cooperative Yielding

Green threads yield control explicitly with `schedulerYield()`:

```milo
from "std/runtime" import { Task, schedulerYield }

fn main(): i32 {
    Task.spawn(move (): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    Task.spawn(move (): void => {
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
from "std/runtime" import { Task, schedulerWaitRead, schedulerWaitWrite }
from "std/event" import { setNonblocking }

let fd: i32 = 0    // e.g. an accepted socket
Task.spawn(move (): void => {
    setNonblocking(fd)
    // ... attempt read ...
    // if EAGAIN:
    schedulerWaitRead(fd)    // yields until fd is readable
    // ... retry read ...
})
```

### Transparent Async I/O

`stream.recv()` and `stream.send()` from `std/net` automatically detect when they're running inside a green thread. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

```milo
from "std/net" import { TcpStream, resolve }
from "std/runtime" import { Task }

let ip = resolve("example.com")!
let port: u16 = 80
Task.spawn(move (): void => {
    let stream = TcpStream.connect(ip, port)!
    stream.send("hello")!         // yields if socket buffer full
    let data = stream.recv()!     // yields until data arrives
    print(data)
})
```

The same `stream.send()`/`stream.recv()` calls work identically outside green threads — they just block normally.

### Echo Server Example

A concurrent echo server handling multiple clients with green threads:

```milo
from "std/os" import { socket, bind, listen, accept, read, write, close, setsockopt, getsockname, ntohs }
from "std/platform" import { makeSockaddr, makeZeroedSockaddr, solSocket, soReuseaddr, getErrno, eagain }
from "std/event" import { setNonblocking }
from "std/runtime" import { Task, schedulerWaitRead }

fn main(): i32 {
    unsafe {
        let serverFd = socket(2, 1, 0)
        // ... bind, listen, setNonblocking(serverFd) ...

        Task.spawn(move (): void => {
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
                Task.spawn(move (): void => {
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

| | OS Thread (`Thread.spawn`) | Green Thread (`Task.spawn`) |
|---|---|---|
| Stack size | ~8MB | 64KB |
| Context switch | Kernel (microseconds) | Userspace (nanoseconds) |
| Max concurrent | ~hundreds | 10K+ |
| Best for | CPU-bound parallelism | I/O-bound concurrency |
| Preemptive | Yes | No (cooperative) |

### Green Thread API

| Function | Description |
|----------|-------------|
| `Task.spawn(move () => {...})` | Spawn a green thread |
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
from "std/sqlite" import { dbOpen, dbQuery, dbBindInt, dbStep, dbColumnText, dbFinalize }

let db = dbOpen("app.db")!
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

## Argument Parsing

The `std/argparse` module provides a declarative CLI argument parser with auto-generated help.

```milo
from "std/argparse" import { newParser }

fn main(): i32 {
    var parser = newParser("mytool", "a helpful description")
    parser.addPositional("file", "input file to process")
    parser.addOptionalPositional("output", "output path")
    parser.addString("format", "f", "output format", "json")
    parser.addBool("verbose", "v", "enable verbose output")
    parser.addI64("count", "n", "number of items", 10)
    parser.addRequired("token", "t", "API token")
    let args = parser.parse()

    let file = args.getString("file")
    let fmt = args.getString("format")
    let verbose = args.getBool("verbose")
    let count = args.getI64("count")
    if args.has("output") {
        let out = args.getString("output")
    }
    return 0
}
```

**Builder methods** (on `&mut ArgParser`):
- `addString(long, short, help, default)` — optional string flag
- `addRequired(long, short, help)` — required string flag (exits if missing)
- `addBool(long, short, help)` — boolean flag (present = true)
- `addI64(long, short, help, default)` — integer flag with validation
- `addPositional(name, help)` — required positional argument
- `addOptionalPositional(name, help)` — optional positional
- `enableTrailingArgs()` — collect remaining args after first positional

**Parsing**:
- `parse()` — parse from process arguments (auto `--help`, exits on error)
- `parseFrom(argv: Vec<string>)` — parse from a provided arg list (argv[0] = program name, skipped)

**Query methods** (on `&ParsedArgs`):
- `getString(name)`, `getI64(name)`, `getU16(name)`, `getBool(name)` — get typed values
- `has(name)` — check if flag/positional was provided
- `.positional` — `Vec<string>` of remaining positional args

The parser auto-handles `--help`/`-h` and validates required args, integer formats, and unknown flags.

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
| Heap | `Heap(value)`, deref with `*heaped` |
| Reference param | `fn f(x: &T)` or `fn f(x: &mut T)` |
| Closure | `(x: i32) => x * 2` |
| Import | `import "file.milo"` |
| Named import | `from "path" import { A, B }` |
| FFI | `extern fn name(args): ret` |
| Opaque foreign type | `extern type Name` |
| Extern struct | `extern struct Name { field: Type }` |
| Struct by value across FFI | `extern fn f(v: ExternStruct): ExternStruct` |
| C header for a library | `milo build-lib lib.milo -o lib.a` writes `lib.h` |
| String to C ptr | `s.cstr()` returns `*u8` |
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
