// The tour's lessons. `desc` and `take` are inline markdown. `out` is the program's
// real output: tests/tour.test.ts runs every lesson through the compiler with the
// flags below and fails if `out` drifts, so edit the code and the output together.

export interface Lesson {
  title: string
  file: string
  desc: string
  take: string
  code: string
  out: string[]
  // Run as `milo run --debug`, where contracts are checked.
  debug?: boolean
  // The lesson demonstrates a rejected program: nonzero exit, `out` is the diagnostic.
  fails?: boolean
}

export const lessons: Lesson[] = [
  {
    title: 'Immutable by default', file: 'values.milo',
    desc: 'A `let` binding is immutable; a `var` is mutable. You opt in to change.',
    take: 'You always know which bindings can change under you: only the ones marked `var`.',
    out: ['hello from Milo, count = 3'],
    code: `fn main(): i32 {
    let name = "Milo"        // immutable
    var count = 0            // mutable
    count = count + 3
    print($"hello from {name}, count = {count}")
    return 0
}`,
  },
  {
    title: 'Ownership and moves', file: 'ownership.milo', fails: true,
    desc: 'A heap value like `string` has one owner. `let b = a` moves it, so using `a` afterwards is a compile error. Change line 3 to `let b = a.clone()` and it compiles.',
    take: 'Small types (`i32`, `f64`) copy automatically. Heap values move unless you `.clone()` them, so copies are never silent, and no GC cleans up behind you.',
    out: ['error: use of moved variable \'a\'', '  ──> ownership.milo:4:11', '  │', '4 │     print(a)     // error: a was moved', '  │           ^', '  hint: ownership of \'a\' was transferred earlier and it can no longer be used here. To keep it alive, clone it at the point of transfer: \'a.clone()\'.'],
    code: `fn main(): i32 {
    let a = "owned string"
    let b = a    // moves a into b
    print(a)     // error: a was moved
    print(b)
    return 0
}`,
  },
  {
    title: 'Borrowing', file: 'borrow.milo',
    desc: 'To lend a value without giving it away, take a `&T` parameter. The caller passes the value bare; the compiler borrows it. A `&mut T` parameter may change the value, and the caller spells that out: `f(&mut x)`.',
    take: 'Reading a call site tells you what it can do: `total(scores)` only reads, `addBonus(&mut scores, 10)` may write. References live only in parameters, never stored or returned, so there are no lifetimes to annotate.',
    out: ['total = 12', 'total = 22', 'scores still has 4 items'],
    code: `fn total(v: &Vec<i32>): i32 {
    var sum: i32 = 0
    for x in v { sum = sum + x }
    return sum
}

fn addBonus(v: &mut Vec<i32>, bonus: i32) {
    v.push(bonus)
}

fn main(): i32 {
    var scores: Vec<i32> = [3, 4, 5]
    // Shared borrow: pass it bare.
    print($"total = {total(scores)}")
    // Mutable borrow: say so at the call.
    addBonus(&mut scores, 10)
    print($"total = {total(scores)}")
    print($"scores still has {scores.len} items")
    return 0
}`,
  },
  {
    title: 'Structs', file: 'geometry.milo',
    desc: 'Group data in a `struct`. `dist` borrows both points with `&Point`, so `main` still owns them after the call.',
    take: 'Field access, struct literals and borrowed parameters are all the ceremony there is.',
    out: ['distance = 5'],
    code: `from "std/math" import { Math }

struct Point { x: f64, y: f64 }

fn dist(a: &Point, b: &Point): f64 {
    let dx = a.x - b.x
    let dy = a.y - b.y
    return Math.sqrt(dx * dx + dy * dy)
}

fn main(): i32 {
    let origin = Point { x: 0.0, y: 0.0 }
    let p = Point { x: 3.0, y: 4.0 }
    print($"distance = {dist(origin, p)}")
    return 0
}`,
  },
  {
    title: 'Enums and exhaustive match', file: 'shapes.milo',
    desc: 'Enums are sum types that carry data. `match` must handle every variant: miss one and it does not compile.',
    take: 'Add a variant and the checker points at every `match` that has to handle it.',
    out: ['circle: 12.56636', 'rect:   12'],
    code: `enum Shape {
    Circle(f64),
    Rect(f64, f64),
}

fn area(s: &Shape): f64 {
    match s {
        Shape.Circle(r) => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
    }
}

fn main(): i32 {
    print($"circle: {area(Shape.Circle(2.0))}")
    print($"rect:   {area(Shape.Rect(3.0, 4.0))}")
    return 0
}`,
  },
  {
    title: 'Collections', file: 'scores.milo',
    desc: 'A growable `Vec` and a `HashMap` come built in. Lookups return an `Option`.',
    take: 'A missing key is `Option.None`, not a crash, and the `match` makes you handle it.',
    out: ['alice scored 92', 'players: 2'],
    code: `fn main(): i32 {
    var scores: HashMap<string, i32> = HashMap.new()
    scores.insert("alice", 92)
    scores.insert("bob", 87)

    match scores.get("alice") {
        Option.Some(s) => { print($"alice scored {s}") }
        Option.None    => { print("no score") }
    }
    print($"players: {scores.len}")
    return 0
}`,
  },
  {
    title: 'Errors are values', file: 'errors.milo',
    desc: 'Fallible functions return `Result`. The `?` operator unwraps success and returns the error early.',
    take: 'Every failure is in the type signature, and `?` keeps the happy path readable.',
    out: ['next year: 43', 'error: empty input'],
    code: `fn parseAge(s: string): Result<i32> {
    if s == "" { return Result.Err("empty input") }
    return Result.Ok(42)
}

fn nextYear(s: string): Result<i32> {
    // ? unwraps Ok, or returns the Err early.
    let age = parseAge(s)?
    return Result.Ok(age + 1)
}

fn main(): i32 {
    match nextYear("hi") {
        Result.Ok(v)  => { print($"next year: {v}") }
        Result.Err(e) => { print($"error: {e}") }
    }
    match nextYear("") {
        Result.Ok(v)  => { print($"next year: {v}") }
        Result.Err(e) => { print($"error: {e}") }
    }
    return 0
}`,
  },
  {
    title: 'Closures and iterators', file: 'closures.milo',
    desc: 'Pass a lambda to `.map`. Closures capture their environment and compose over collections.',
    take: 'Functions are values: closures, `.map`, `.filter` and `for..in` work the way you expect.',
    out: ['2', '4', '6'],
    code: `fn main(): i32 {
    var nums: Vec<i32> = Vec.new()
    nums.push(1)
    nums.push(2)
    nums.push(3)
    let doubled = nums.map((n: i32): i32 => n * 2)
    for x in doubled {
        print(x)
    }
    return 0
}`,
  },
  {
    title: 'Generics, monomorphized', file: 'generics.milo',
    desc: 'Write once over a type parameter; the compiler stamps out a specialized copy per concrete type, with no boxing.',
    take: 'Inference fills in the type parameters, and monomorphization keeps it as fast as hand-written code.',
    out: ['milo 42'],
    code: `struct Pair<A, B> { first: A, second: B }

fn flip<A, B>(p: Pair<A, B>): Pair<B, A> {
    return Pair { first: p.second, second: p.first }
}

fn main(): i32 {
    let p = flip(Pair { first: 42, second: "milo" })
    print($"{p.first} {p.second}")
    return 0
}`,
  },
  {
    title: 'Interfaces and dynamic dispatch', file: 'traits.milo',
    desc: 'An `interface` defines behavior; any struct with matching methods satisfies it. A `&Greeter` dispatches at runtime, so it is Milo\'s trait object (a `trait` only dispatches statically).',
    take: 'One call site, many concrete types, dispatched through a fat pointer of data plus a method table.',
    out: ['Woof', 'Meow'],
    code: `interface Greeter {
    fn greet(self: &Self): string
}

struct Dog {}
impl Dog { fn greet(self: &Self): string { return "Woof" } }

struct Cat {}
impl Cat { fn greet(self: &Self): string { return "Meow" } }

fn announce(g: &Greeter) {
    print(g.greet())
}

fn main(): i32 {
    announce(Dog {})
    announce(Cat {})
    return 0
}`,
  },
  {
    title: 'Parse JSON into typed values', file: 'json.milo',
    desc: '`jsonParse` returns a `Result`; `!` unwraps it or aborts. `.get()` returns an `Option` per key, and typed accessors like `asStr` and `asI64` return an `Option` you must handle.',
    take: 'JSON lives in the standard library, written in Milo. Values come out typed, with no unchecked casts.',
    out: ['name: milo', 'stars: 42'],
    code: `from "std/json" import { jsonParse }

fn main(): i32 {
    // The kind of document an HTTP body carries.
    let src = "{\\"name\\": \\"milo\\", \\"stars\\": 42}"

    // Result: ! unwraps it or aborts.
    let doc = jsonParse(src)!
    if let Option.Some(v) = doc.get("name") {
        if let Option.Some(s) = v.asStr() { print($"name: {s}") }
    }
    if let Option.Some(v) = doc.get("stars") {
        if let Option.Some(n) = v.asI64() { print($"stars: {n}") }
    }
    return 0
}`,
  },
  {
    title: 'Contracts, checked or proven', file: 'clamp.milo', debug: true, fails: true,
    desc: '`requires` states what the caller must guarantee and `ensures` what the function promises back, in ordinary Milo. This `clamp` has an easy bug: the low branch returns `value` instead of `lo`. In a debug build the first call passes, but `clamp(-5, 0, 10)` returns `-5`, which breaks `ensures`, and the check stops the program.',
    take: 'A plain `milo run` skips contract checks; a debug build (or `--contract-checks`) runs them. `milo prove` checks the same conditions for every input at compile time, with the solver in the standard library, and reports a counterexample for this `clamp` before anything runs.',
    out: ['10', 'runtime error: ensures clause violated at clamp.milo:3'],
    code: `fn clamp(value: i64, lo: i64, hi: i64): i64
requires lo <= hi
ensures result >= lo && result <= hi
{
    // bug: should return lo
    if value < lo { return value }
    if value > hi { return hi }
    return value
}

fn main(): i32 {
    print(clamp(42, 0, 10))  // 10, fine
    print(clamp(-5, 0, 10))  // breaks ensures
    return 0
}`,
  },
  {
    title: 'Putting it together', file: 'sales.milo',
    desc: 'The pieces from earlier lessons at once: `struct`s in a `Vec`, a computed value, an `if` used as an expression, and `.filter` with a closure.',
    take: 'Nothing new here. Structs, a `Vec`, an if-expression and a closure compose into a real program, and that is most of what everyday code needs.',
    out: ['widget: 3 x 250 = 750  <- big', 'gadget: 1 x 999 = 999  <- big', 'gizmo: 5 x 120 = 600', 'total: 2349 cents, 2 bulk orders'],
    code: `struct Sale { item: string, qty: i32, price: i32 }

fn main(): i32 {
    let sales: Vec<Sale> = [
        Sale { item: "widget", qty: 3, price: 250 },
        Sale { item: "gadget", qty: 1, price: 999 },
        Sale { item: "gizmo",  qty: 5, price: 120 },
    ]
    var total: i32 = 0
    for s in sales {
        let line = s.qty * s.price
        total = total + line
        let flag = if line > 700 { "  <- big" } else { "" }
        print($"{s.item}: {s.qty} x {s.price} = {line}{flag}")
    }
    let bulk = sales.filter((s) => s.qty >= 3)
    print($"total: {total} cents, {bulk.len} bulk orders")
    return 0
}`,
  },
]
