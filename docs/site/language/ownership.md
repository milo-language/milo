# Ownership

Milo guarantees memory safety at compile time using two mechanisms: move semantics and second-class references. No garbage collector, no reference counting, no lifetime annotations.

## Move semantics

Each value has exactly one owner. Assignment transfers ownership — the old name is dead.

```milo
var a = "hello"
let b = a          // ownership moves to b
print(a)           // compile error: a was moved
```

```
error: use of moved variable 'a'
  --> example.milo:3:7
  |
3 |     print(a)
  |           ^
  hint: ownership of 'a' was transferred earlier and it can no longer be used here.
        To keep it alive, clone it at the point of transfer: 'a.clone()'.
```

No runtime cost. The compiler catches it before the program runs.

Primitive types (`i32`, `bool`, `f64`, etc.) are copied, not moved. Structs, enums, strings, Vec, HashMap, and Box all move.

## Moves through control flow

The compiler tracks moves through branches:

```milo
let p = Point { x: 1, y: 2 }
if condition {
    consume(p)     // p moved here
} else {
    consume(p)     // p moved here — OK, only one branch executes
}
// p is invalid here regardless of which branch ran
```

## Cloning

When you need to keep the original, explicitly clone:

```milo
let a = "hello"
let b = a.clone()  // deep copy
print(a)           // still valid
print(b)           // also valid
```

## Second-class references

References (`&T`) can **only** appear as function parameters. They cannot be returned, stored in structs, or assigned to variables.

```milo
// OK — borrow for the duration of the call
fn length(s: &string): i64 {
    return s.len
}

// COMPILE ERROR — can't return a reference
fn bad(): &string { ... }

// COMPILE ERROR — can't store a reference
struct Bad { ref: &string }
```

This one restriction eliminates lifetime annotations entirely. In Rust, storing a reference in a struct requires `<'a>` on the struct, the impl, and everything that contains it. In Milo, you own the data instead. The restriction *is* the borrow checker.

## Mutable references

`&mut T` lets a function mutate the caller's value:

```milo
fn double(x: &mut i32) {
    x = x * 2
}

var n: i32 = 21
double(n)          // n is now 42
```

## Auto-borrow

Milo auto-borrows at call sites. You write `greet(u)` not `greet(&u)`:

```milo
fn greet(user: &User): string {
    return "hi, " + user.name
}

let u = User { name: "Alice", age: 30 }
print(greet(u))        // auto-borrows u
print("age: ", u.age)  // u is still valid
```

## Isn't this too restrictive?

In practice, the overwhelming majority of references are function arguments — "give me this value briefly, I won't keep it." The rare cases where you'd want to store a reference (iterators, self-referential structs) are handled differently: owned data, Vec indices, or [generational arenas](/stdlib/).

The tradeoff: a much simpler mental model and zero annotation overhead for the 95% case.

Next: [Collections →](./collections)
