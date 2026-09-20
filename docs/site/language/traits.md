# Traits

Traits define shared behavior across types.

## Defining a trait

```milo
trait Eq {
    fn eq(self: &Self, other: &Self): bool
}
```

## Implementing a trait

```milo
struct Point { x: i32, y: i32 }

impl Eq for Point {
    fn eq(self: &Self, other: &Self): bool {
        return self.x == other.x && self.y == other.y
    }
}
```

## Default methods

```milo
trait Greet {
    fn greet(self: &Self): i32 {
        return 42    // default implementation
    }
}

struct Cat { name: i32 }
impl Greet for Cat {}    // uses the default
```

## Generic bounds

Constrain type parameters to require trait implementations:

```milo
fn printIfEqual<T: Eq>(a: &T, b: &T) {
    if a.eq(b) {
        print("equal!")
    }
}
```

Multiple bounds:

```milo skip
fn process<T: Eq + Hash>(item: &T) { ... }
```

## Supertraits

```milo
trait Ord: Eq {
    fn compare(self: &Self, other: &Self): i32
}
```

Implementing `Ord` requires `Eq` to be implemented as well.

## @derive

Auto-generate trait implementations:

```milo
@derive(Eq)
struct Point { x: i32, y: i32 }
```

## Operator overloading

Implementing `Add`, `Sub`, `Mul`, `Div` or `Eq` for your type makes the corresponding
operator work on it. Dispatch is static — there is no runtime lookup.

```milo
struct Vec2 {
    x: i32,
    y: i32,
}

impl Add for Vec2 {
    fn add(self: &Self, other: &Self): Self {
        return Vec2 { x: self.x + other.x, y: self.y + other.y }
    }
}

let sum = Vec2 { x: 3, y: 4 } + Vec2 { x: 5, y: 6 }
print(sum.x)   // 8
```

## What's not here yet

- `dyn Trait` (trait objects)
- Associated types
- `where` clauses


For runtime polymorphism (heterogeneous collections, virtual dispatch), use [interfaces](/language/#interfaces) instead. These items are on the roadmap.

Next: [Closures](./closures)
