# Welcome to Milo!

Milo takes our favorite features from Rust, TypeScript, Python and more to make a fast, memory-safe language that's easy for both people and AI to read and write. It compiles to native code via LLVM, manages memory automatically through ownership tracking, and doesn't need a garbage collector, reference counting, or lifetime annotations.

Milo also takes a data-driven approach to language design. We survey real code from popular libraries and codebases to find the most common patterns, then make those the default or the easiest path in Milo. The result is a language where the thing you reach for first is usually the right thing.

This page walks through every major concept with runnable examples. [Open the Playground](/playground) to try them as you go.

## Hello, Milo

```milo
fn main(): i32 {
    print("Hello, Milo!")
    return 0
}
```

Every program starts at `main`, which returns an `i32` exit code. `print` is a built-in.

## Variables

`let` is immutable. `var` is mutable. Types are inferred or annotated.

```milo
fn main(): i32 {
    let x = 42              // immutable, type inferred as i32
    var count: i32 = 0      // mutable, type annotated
    count = count + 1

    let name = "Milo"       // string
    let pi = 3.14           // f64
    let yes = true           // bool

    print($"{name} v{x}, pi={pi}, count={count}")
    return 0
}
```

Primitive types: `i8`–`i64`, `u8`–`u64`, `f32`, `f64`, `bool`. Convenience aliases: `int` = `i64`, `float` = `f64`, `byte` = `u8`.

[Full details →](/language/variables)

## Strings

Strings are owned UTF-8 byte buffers — they grow, shrink, and free themselves automatically. You can concatenate with `+`, interpolate with `$"..."`, slice with `[start..end]` for zero-copy views, and call methods like `split`, `toUpper`, and `contains` directly.

```milo
fn main(): i32 {
    let name = "Milo"
    let greeting = $"Hello, {name}!"
    print(greeting)                    // Hello, Milo!

    let words = greeting.split(" ")
    print(words.join(" | "))           // Hello, | Milo!

    let upper = name.toUpper()
    print(upper)                       // MILO

    let slice = greeting[0..5]         // &string, zero-copy borrow
    print(slice)                       // Hello
    return 0
}
```

[Full details →](/language/strings)

## Functions

```milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: string): void {
    print($"hello, {name}")
}

fn identity<T>(x: T): T {
    return x
}

fn main(): i32 {
    print(add(2, 3))             // 5
    greet("world")               // hello, world
    print(identity("generic!"))  // generic!
    return 0
}
```

Generics use `<T>` syntax. The compiler generates specialized versions for each type you use, so generic code runs just as fast as if you'd written it by hand. You write `identity<T>` once, and it works with `i32`, `string`, or any type.

[Full details →](/language/functions)

## Structs

Define your own types with named fields, then attach methods to them. Structs are the building blocks of most Milo programs — you'll use them for everything from coordinates to HTTP requests to database rows.

```milo
struct Point {
    x: i32,
    y: i32,
}

impl Point {
    fn manhattan(self: &Self): i32 {
        return self.x + self.y
    }
}

fn main(): i32 {
    let p = Point { x: 3, y: 4 }
    print(p.manhattan())   // 7
    return 0
}
```

Structs can be generic too — `Pair<A, B>`, `Box<T>`, etc. The standard library's `Vec<T>` and `HashMap<K, V>` are generic structs.

[Full details →](/language/structs)

## Enums and Pattern Matching

Enums in Milo are more powerful than enums in most languages. Each variant can carry different data, making them perfect for modeling states, results, and anything with multiple cases. Think of them as "this value is one of these things" — and the compiler makes sure you handle every possibility.

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

fn main(): i32 {
    print(area(Shape.Circle(5.0)))    // 78.53975
    print(area(Shape.Rect(3.0, 4.0))) // 12.0
    return 0
}
```

`Option<T>` and `Result<T, E>` are built-in enums — they replace null and exceptions with something the compiler can check. Forget to handle an error case? It won't compile.

[Full details →](/language/enums)

## Ownership and Moves

This is the big one — and it's simpler than you might think. Milo doesn't have a garbage collector or a borrow checker with lifetime annotations. Instead, there's one rule: every value has one owner. When you assign it somewhere else, the original name is done.

```milo
fn main(): i32 {
    let a = "hello"
    let b = a          // a is moved into b
    // print(a)        // compile error: use of moved variable 'a'
    print(b)           // works fine
    return 0
}
```

That's it. From this one rule, the compiler can free memory automatically, prevent use-after-free bugs, and eliminate data races — all without runtime overhead.

Numbers and booleans are small enough to just copy, so they don't move. Everything else — strings, structs, enums, Vec, Box — transfers ownership on assignment.

When you need to keep the original, clone it:

```milo
fn main(): i32 {
    let a = "hello"
    let b = a.clone()   // a stays valid
    print(a)             // fine
    print(b)             // fine
    return 0
}
```

If you've heard scary things about Rust's borrow checker, don't worry — Milo is deliberately simpler. No lifetime annotations, ever. The tradeoff is that references can only be used as function parameters, not stored in structs or returned. In practice, this covers the vast majority of use cases and is much easier to learn.

[Full details →](/language/ownership)

## References

References (`&T`) let functions borrow values without taking ownership. Milo's main innovation is making references *second-class* — they can only exist as function parameters and local variables, never stored in structs or returned from functions. This one restriction collapses an enormous amount of complexity: no lifetime annotations, no borrow checker rules to memorize, no fighting the compiler. Dangling references become structurally impossible, and the mental model fits in one sentence.

```milo
fn length(s: &string): i64 {
    return s.len
}

fn double(x: &mut i32) {
    x = x * 2
}

fn main(): i32 {
    let s = "hello"
    print(length(s))    // 5 — s is borrowed, not moved

    var n: i32 = 21
    double(n)            // n is now 42
    print(n)
    return 0
}
```

[Full details →](/language/ownership)

## Error Handling

Milo has no exceptions and no null. Instead, the type system makes you deal with errors and missing values explicitly — but with enough syntactic sugar that it doesn't feel heavy.

Remember those enums with payloads from the previous section? `Result<T, E>` is just an enum with two variants: `Result.Ok(value)` for success or `Result.Err(error)` for failure. Similarly, `Option<T>` is `Option.Some(value)` or `Option.None`. The compiler won't let you use the inner value without checking which case you're in.

The `?` operator is where it gets ergonomic: if a result is an error, `?` returns it from the current function automatically. No try/catch blocks, no forgotten error checks.

```milo
fn divide(a: f64, b: f64): Result<f64, string> {
    if b == 0.0 {
        return Result.Err("division by zero")
    }
    return Result.Ok(a / b)
}

fn calculate(x: f64): Result<f64, string> {
    let half = divide(x, 2.0)?       // propagate error with ?
    let result = divide(half, 0.0)?   // this will propagate Err
    return Result.Ok(result)
}

fn main(): i32 {
    let good = divide(10.0, 3.0)!     // unwrap with ! — panics on Err
    print(good)

    match calculate(10.0) {
        Result.Ok(v) => { print(v) }
        Result.Err(e) => { print($"error: {e}") }
    }
    return 0
}
```

You can also write `T?` as shorthand for `Option<T>`, and `value ?? default` to provide a fallback when something is `None`.

[Full details →](/language/error-handling)

## Collections

Milo comes with growable arrays and hash maps out of the box. `Vec<T>` is the workhorse — you'll use it constantly. It owns its elements, frees them when it goes out of scope, and has built-in methods like `map`, `filter`, and `join` that make working with data feel natural.

### Vec — dynamic arrays

```milo
fn main(): i32 {
    let v: Vec<i32> = [10, 20, 30]

    let doubled = v.map((n: &i32) => n * 2)
    let evens = v.filter((n: &i32) => n % 2 == 0)

    print(doubled.join(", "))   // 20, 40, 60

    for item in v {
        print(item)
    }
    return 0
}
```

### HashMap — key-value store

```milo
fn main(): i32 {
    var m: HashMap<string, i32> = HashMap.new()
    m.insert("alice", 42)
    m.insert("bob", 99)

    if let Option.Some(v) = m.get("alice") {
        print($"alice = {v}")
    }
    return 0
}
```

[Full details →](/language/collections)

## Closures

Closures are anonymous functions with a familiar arrow syntax. They can capture variables from their surrounding scope, get passed as arguments, stored in variables, and returned from functions. This is what powers `map`, `filter`, and other functional patterns on collections.

There are two kinds. Regular closures capture variables by reference — they point back to the original, so mutations are visible outside. But they can't outlive the scope they were created in.

`move` closures take ownership of the variables they capture. For owned types like strings and structs, the value moves into the closure and the original is gone (just like any other move). For primitives, it's a copy. The closure packs everything it needs into a heap-allocated environment, so it's self-contained — safe to return from functions, store in structs, or send to another thread.

```milo
fn makeAdder(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x + n    // n (an i32) is copied into the closure
    }
}

fn main(): i32 {
    let nums: Vec<i32> = [1, 2, 3, 4, 5]
    let squared = nums.map((n: &i32) => n * n)
    print(squared.join(", "))     // 1, 4, 9, 16, 25

    let add10 = makeAdder(10)     // returns a closure with 10 baked in
    print(add10(5))               // 15
    print(add10(100))             // 110
    return 0
}
```

[Full details →](/language/closures)

## Traits

Traits let different types share a common interface. If you've used interfaces in Go or TypeScript, this will feel familiar — but Milo traits can also have default implementations, constrain generics, and enable operator overloading (`+`, `-`, `==`, etc.).

```milo
trait Area {
    fn area(self: &Self): f64
}

struct Circle { radius: f64 }
struct Square { side: f64 }

impl Area for Circle {
    fn area(self: &Self): f64 {
        return 3.14159 * self.radius * self.radius
    }
}

impl Area for Square {
    fn area(self: &Self): f64 {
        return self.side * self.side
    }
}

fn main(): i32 {
    let c = Circle { radius: 5.0 }
    let s = Square { side: 4.0 }
    print(c.area())   // 78.53975
    print(s.area())   // 16.0
    return 0
}
```

Use `@derive(Eq)` to auto-generate equality comparisons instead of writing them by hand.

[Full details →](/language/traits)

## Concurrency

Milo makes concurrent programming safe and straightforward. Spawn OS threads for parallel computation, use channels to pass messages between them, and let the compiler verify thread safety at compile time. If you accidentally try to share mutable state across threads, it won't compile — data races are caught before your code runs.

```milo
from "std/thread" import { Thread, threadJoin }
from "std/sync" import { channelNew, channelSend, channelRecv, channelDestroy }

fn main(): i32 {
    let ch = channelNew(8)!

    let producer = Thread.spawn(move (): void => {
        for i in 1..6 {
            channelSend(ch, i as i64)!
        }
        channelSend(ch, 0)!
    })!

    while true {
        let val = channelRecv(ch)!
        if val == 0 { break }
        print($"received: {val}")
    }

    threadJoin(producer)!
    channelDestroy(ch)
    return 0
}
```

For I/O-heavy workloads, Milo also has green threads (`greenSpawn`) that run thousands of lightweight tasks concurrently, plus mutexes, rwlocks, and atomics when you need them.

[Full details →](/language/concurrency)

## Modules and Packages

Every import is explicit — you list exactly which symbols you're using. No wildcard imports, no ambiguity about where something comes from. This keeps code readable and makes it easy for both people and tools to understand dependencies at a glance.

```milo
from "std/http" import { Context, Response, Router, serveRouter }
from "std/json" import { jsonParse }
from "lib/utils" import { validate }
```

Milo has a built-in package manager for installing and managing third-party dependencies. The standard library covers I/O, networking, HTTP, JSON, SQLite, testing, date/time, crypto, and more. [See the full stdlib →](/stdlib/)

[Full details →](/language/modules)

## What's next

You've seen the core of Milo. To go deeper:

- **[Learn step by step](/language/variables)** — work through each topic in detail
- **[Try it in the Playground](/playground)** — write and run Milo in your browser
- **[Install Milo](/getting-started/installation)** — build real programs locally
- **[Standard Library](/stdlib/)** — HTTP servers, JSON, SQLite, concurrency, and more
- **[Examples](/examples)** — complete programs: CLI tools, web servers, games
