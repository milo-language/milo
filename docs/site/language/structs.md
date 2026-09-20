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

Any struct can be serialized with the built-in `jsonStringify`:

```milo
struct User {
    name: string,
    age: i32,
    active: bool,
}

let user = User { name: "Alice", age: 30, active: true }
let json = jsonStringify(user)
// {"name":"Alice","age":30,"active":true}
```

Next: [Enums & Matching](./enums)

## Visibility

Fields and methods are private by default. Mark them `pub` to export from a module:

```milo
struct Config {
    pub host: string,
    pub port: i32,
    secret: string,       // private, only visible in this module
}
```

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
