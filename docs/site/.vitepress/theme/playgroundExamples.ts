// Programs the playground offers. tests/playground.test.ts runs every one through the built
// bundle and checks `expect` (stdout) or `error` (a substring of the rendered diagnostics), so
// an example the interpreter stops supporting fails a test instead of a visitor.
export interface PlaygroundExample { id: string; title: string; code: string; expect?: string; error?: string }

export const EXAMPLES: PlaygroundExample[] = [
  {
    id: "hello",
    title: "Hello, Milo",
    code: `// Hello, Milo. Edit and press Run.
pub fn main(): i32 {
    print("Hello, Milo!")
    return 0
}
`,
    expect: "Hello, Milo!\n",
  },
  {
    id: "move-error",
    title: "Ownership: use after move (error)",
    code: `// One owner per value. consume(names) moves the Vec, so the later use is an error.
//
// How to fix it: consume only reads v, so borrow it instead of taking it.
// Change the parameter to  v: &Vec<string>  and keep the call as  consume(names).
// A shared borrow is implicit at the call site, and names stays usable afterwards.
fn consume(v: Vec<string>): i64 {
    return v.len()
}

pub fn main(): i32 {
    var names: Vec<string> = Vec.new()
    names.push("ada")
    names.push("grace")
    let n = consume(names)    // names moves into consume here
    print(n)
    print(names.len())        // error: use of moved variable 'names'
    return 0
}
`,
    error: "moved",
  },
  {
    id: "mut-borrow",
    title: "Borrowing: &mut",
    code: `// A &mut parameter borrows for the call. The call site spells it &mut.
fn bump(counter: &mut i64, by: i64) {
    counter = counter + by
}

pub fn main(): i32 {
    var total: i64 = 0
    bump(&mut total, 5)
    bump(&mut total, 37)
    print(total)
    return 0
}
`,
    expect: "42\n",
  },
  {
    id: "struct-match",
    title: "Struct, enum and match",
    code: `// A struct with a method, and an enum taken apart with match.
struct Rect {
    w: i64
    h: i64
}

impl Rect {
    fn area(self: &Self): i64 {
        return self.w * self.h
    }
}

enum Shape {
    Square(i64)
    Box(Rect)
    Dot
}

fn describe(s: &Shape): i64 {
    match s {
        Shape.Square(side) => { return side * side }
        Shape.Box(r) => { return r.area() }
        Shape.Dot => { return 0 }
    }
}

pub fn main(): i32 {
    print(describe(Shape.Square(4)))
    print(describe(Shape.Box(Rect { w: 3, h: 5 })))
    print(describe(Shape.Dot))
    return 0
}
`,
    expect: "16\n15\n0\n",
  },
  {
    id: "vec-for",
    title: "Vec and for-in",
    code: `// Vec and for-in.
pub fn main(): i32 {
    var squares: Vec<i64> = Vec.new()
    for i in 1..6 {
        squares.push(i * i)
    }
    var sum: i64 = 0
    for s in squares {
        print(s)
        sum = sum + s
    }
    print($"sum = {sum}")
    return 0
}
`,
    expect: "1\n4\n9\n16\n25\nsum = 55\n",
  },
  {
    id: "option-try",
    title: "Option and ?",
    code: `// Option and ?: the first None short-circuits the whole function.
fn half(x: i64): i64? {
    if x % 2 == 0 {
        return Option.Some(x / 2)
    }
    return Option.None
}

fn quarter(x: i64): i64? {
    let h = half(x)?
    return half(h)
}

fn show(x: i64) {
    match quarter(x) {
        Option.Some(v) => { print($"quarter({x}) = {v}") }
        Option.None => { print($"quarter({x}) = none") }
    }
}

pub fn main(): i32 {
    show(20)
    show(6)
    show(7)
    return 0
}
`,
    expect: "quarter(20) = 5\nquarter(6) = none\nquarter(7) = none\n",
  },
  {
    id: "interpolation",
    title: "String interpolation",
    code: `// String interpolation with $"...".
struct Point {
    x: i64
    y: i64
}

pub fn main(): i32 {
    let name = "Milo"
    let p = Point { x: 3, y: 4 }
    print($"hello, {name}!")
    print($"point = ({p.x}, {p.y})")
    print($"x * y = {p.x * p.y}")
    return 0
}
`,
    expect: "hello, Milo!\npoint = (3, 4)\nx * y = 12\n",
  },
  {
    id: "closure",
    title: "Closures: capture and pass",
    code: `// A closure captures a local and can be passed to a function.
fn apply_twice(f: (i64) => i64, x: i64): i64 {
    return f(f(x))
}

pub fn main(): i32 {
    let offset: i64 = 100
    let add = (x: i64): i64 => x + offset
    print(add(5))
    print(apply_twice(add, 1))
    print(apply_twice((x: i64): i64 => x * x, 3))
    return 0
}
`,
    expect: "105\n201\n81\n",
  },
];
