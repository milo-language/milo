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

## JSON serialization

Any struct can be serialized with the built-in `json_stringify`:

```milo
struct User {
    name: string,
    age: i32,
    active: bool,
}

let user = User { name: "Alice", age: 30, active: true }
let json = json_stringify(user)
// {"name":"Alice","age":30,"active":true}
```

Next: [Enums & Matching →](./enums)
