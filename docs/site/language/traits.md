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

## Interfaces

A trait call is resolved at compile time, once per concrete type. When the concrete type is only known at runtime (a list of mixed shapes, a plugin), use an `interface`. An interface lists methods. Any type that has those methods satisfies it, with no declaration naming the interface: inherent methods and trait impls both count. An interface value is a fat pointer to the data plus a table of that type's methods, and each call goes through the table.

`&Greeter` as a parameter accepts any type that satisfies `Greeter`. `Heap<Greeter>` owns one, so a `Vec<Heap<Greeter>>` can hold mixed types. This is Milo's trait object.

```milo
interface Greeter {
    fn greet(self: &Self): string
}

struct Dog { name: string }
impl Dog {
    fn greet(self: &Self): string { return "woof from " + self.name }
}

struct Cat {}
impl Cat {
    fn greet(self: &Self): string { return "meow" }
}

fn sayHello(g: &Greeter) {
    print(g.greet())
}

fn main(): i32 {
    sayHello(Dog { name: "Rex" })   // woof from Rex

    var all: Vec<Heap<Greeter>> = Vec.new()
    all.push(Heap(Dog { name: "Fido" }))
    all.push(Heap(Cat {}))
    for g in all {
        print(g.greet())            // woof from Fido, meow
    }
    return 0
}
```

## What's not here yet

- `dyn Trait`: a `trait` dispatches statically only, and `&Eq` is not a type. Use an [interface](#interfaces) for runtime dispatch.
- Associated types
- `where` clauses

None of these is planned; associated types are listed under [Not Planned](/roadmap#not-planned).
