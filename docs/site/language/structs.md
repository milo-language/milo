# Structs

Structs are value types with move semantics.

## Basics

```milo
struct Point {
    x: i32,
    y: i32,
}

let p = Point { x: 10, y: 20 }
print(p.x)

var q = Point { x: 1, y: 2 }
q.x = 99
```

## Generic structs

```milo
struct Pair<A, B> {
    first: A,
    second: B,
}

let p = Pair { first: 42, second: "hello" }
```

The type arguments come from the fields. When no field fixes one (an empty `Vec<T>`
field), spell them on the literal, or annotate the binding:

```milo
struct Bag<T> {
    items: Vec<T>,
}

let b = Bag<i64> { items: [] }
let c: Bag<string> = Bag { items: [] }
```

A static method on a generic struct is called bare when its type arguments can be worked
out: from the arguments (`Pair.of(1, "a")`), or, for a method whose arguments do not
mention them, from the type the context expects of the call, which is a binding's
annotation, a parameter, or a return type:

```milo
struct Stack<T> {
    items: Vec<T>,
}

impl Stack<T> {
    fn new(): Stack<T> {
        return Stack { items: [] }
    }
}

fn fresh(): Stack<string> {
    return Stack.new()           // T = string, from the return type
}

var s: Stack<i64> = Stack.new()  // T = i64, from the annotation
let t = Stack<bool>.new()        // spelled out; always accepted
```

With nothing to infer from (`let u = Stack.new()`), the error says which type arguments
are missing and shows both spellings. `std/arena`'s `var a: Arena<Node> = Arena.new()` is
the same shape.

## Methods

Use `impl` to define methods on a struct:

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

A method with no `self` parameter is a static method, called on the type. It may carry
its own type parameters, inferred from the arguments (or, failing that, from the type the
result is assigned to). `std/math`'s `Math.min` and `Math.max` are written this way, so
one name serves every numeric type:

```milo
struct Temp {
    c: f64,
}

impl Temp {
    fn fromF(f: f64): Temp {
        return Temp { c: (f - 32.0) * 5.0 / 9.0 }
    }

    fn larger<T>(a: T, b: T): T {
        if a > b {
            return a
        }
        return b
    }
}

let t = Temp.fromF(212.0)
print(t.c)                     // 100
print(Temp.larger(3, 9))       // 9
print(Temp.larger(0.5, 0.25))  // 0.5
```

## Destructuring

`let { a, b } = e` binds fields of a struct value by name. `{ a: x }` renames, and
`var { … }` makes the bindings mutable.

```milo
struct Match { start: i64, len: i64, text: string }

fn find(): Match {
    return Match { start: 4, len: 3, text: "abc" }
}

fn main() {
    let { start, text } = find()
    print($"{start} {text}")    // 4 abc

    let m = find()
    let { len: n } = m          // renamed; m.start is still usable, only len was taken
    print($"{n} {m.start}")     // 3 4
}
```

It is the same as writing `let a = e.a` for each field (through a hidden temporary when
`e` is not a place), so the ownership rules are a field read's: a Copy field is copied, a
non-Copy field of a value moves out of it, a field of a `&S` cannot be moved out, and a
struct with `Drop` cannot be taken apart. Fields you do not name stay where they were.

There is no tuple type: two values come back as a named struct and are bound this way.

## Visibility and private fields

A struct is file-private unless declared `pub struct`. There is no per-field `pub`: every
field of a visible struct is visible, except a field whose name starts with `_`. That one
can be read, written, or named in a struct literal only inside the file that declares the
struct. Other files use whatever constructor and accessors that file exports:

```milo skip
// counter.milo
pub struct Counter {
    _n: i32,
}

pub fn newCounter(): Counter {
    return Counter { _n: 0 }
}

impl Counter {
    fn bump(self: &mut Self) {
        self._n += 1
    }
    fn value(self: &Self): i32 {
        return self._n
    }
}

// main.milo
var c = newCounter()
c.bump()
print(c.value())
c._n = 5        // error: field '_n' of 'Counter' is private to 'counter.milo'
```

There is no keyword: the leading underscore is the whole rule, and it applies to fields
only (a function named `_helper` is an ordinary function). Derived methods
(`@derive(Eq)`, `@derive(Json)`, ...) are generated in the declaring file's scope, so
`@derive(Json)` still serializes `_` fields.

## JSON serialization

The built-in `jsonStringify(user)` serializes a struct to a JSON string, with no import.
Parsing is [std/json](/stdlib/json).

## Drop

Implement `Drop` to run cleanup when a value goes out of scope:

```milo
struct Handle {
    id: i32,
}

impl Drop for Handle {
    fn drop(self: &mut Self): void {
        print("closing handle ", self.id)
    }
}
```

## Annotations

`@noCopy` prevents implicit copies. `@derive(Eq)` auto-generates `==` and `!=`. See [Annotations & Builtins](/features/annotations) for the full list.

```milo
@noCopy
struct UniqueToken {
    id: i64,
}
```
