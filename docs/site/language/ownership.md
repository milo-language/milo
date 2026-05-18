# Ownership

In most languages, memory bugs hide until production. In Milo, the compiler catches them before your code runs — no garbage collector slowing things down, no manual `free()` to forget.

The idea is simple: **every value has one owner.** When you hand a value to someone else, you don't have it anymore. That's it. The compiler enforces this rule, and from it you get memory safety, no dangling pointers, and no data races — all at zero runtime cost.

Two mechanisms make this work: moves (transferring ownership) and borrows (temporary, read-only access). Let's start with moves.

## Moves

When you assign a value, ownership transfers — the old name is gone.

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

Primitive types (`i32`, `bool`, `f64`, etc.) are copied, not moved. Structs, enums, strings, Vec, HashMap, and Heap all move.

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

## Borrowing — look but don't keep

Sometimes a function just needs to *read* a value without taking it. That's a borrow: `&T`. The key restriction — references can **only** appear as function parameters. They cannot be returned, stored in structs, or assigned to variables.

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

This one restriction means you never write lifetime annotations. If you've seen Rust's `<'a>` on structs, impls, and everything they touch — that doesn't exist in Milo. You own the data instead. The restriction *is* the borrow checker, and it's simple enough to fit in one sentence.

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
