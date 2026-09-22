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
