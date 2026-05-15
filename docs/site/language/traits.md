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

```milo
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

## What's not here yet

- `dyn Trait` (trait objects)
- Associated types
- Operator overloading
- `where` clauses

These are on the roadmap.

Next: [Closures →](./closures)
