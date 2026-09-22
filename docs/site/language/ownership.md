<!-- doc-meta
system: site-ownership
purpose: the site's introduction to moves, clones, borrows and views; the reader's first contact with second-class references
key-files: src/checker.ts, docs/language-reference.md
update-when: the reference rules change (where a reference may live, what freezes an owner, what a method may return, how a call spells a mutable borrow)
last-verified: 2026-09-20 (explicit &mut on call arguments)
-->

# Ownership

In most languages, memory bugs hide until production. In Milo, the compiler catches them before your code runs — no garbage collector slowing things down, no manual `free()` to forget.

The idea is simple: **every value has one owner.** When you hand a value to someone else, you don't have it anymore. That's it. The compiler enforces this rule, and from it you get memory safety, no dangling pointers, and no data races. The ownership and borrow checks happen at compile time and cost nothing at runtime; bounds checks, overflow traps and arena handle checks are the parts that run.

Two mechanisms make this work: moves (transferring ownership) and borrows (shared read-only or mutable access that never outlives the call or scope that made it).

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

Sometimes a function just needs to *read* a value without taking it. That's a borrow: `&T`. A reference lives in exactly two places: a function parameter, or a local view such as `let mid = v[1..3]` or `let key = line[0..4]`. A view freezes its owner for the life of the binding. What a reference can never do is outlive the scope that made it: it cannot be stored in a struct or a collection, captured by a closure (a closure may borrow an owned local, never a reference), or returned. The one exception: a method may return a view of `self`.

```milo skip
// OK: borrow for the duration of the call
fn length(s: &string): i64 {
    return s.len
}

// COMPILE ERROR: a free function can't return a reference
fn bad(): &string { ... }

// COMPILE ERROR: can't store a reference
struct Bad { ref: &string }
```

A local view costs no copy, and the owner is frozen until the view is gone:

```milo error
var v: Vec<i64> = [10, 20, 30]
let mid = v[1..3]      // a view into v, nothing copied
v.push(40)             // error: cannot call 'push' on 'v' because it is borrowed
print(mid.len)
```

This one restriction means you never write lifetime annotations. If you've seen Rust's `<'a>` on structs, impls, and everything they touch — that doesn't exist in Milo. You own the data instead. The restriction *is* the borrow checker, and it's simple enough to fit in one sentence.

## Mutable references

`&mut T` lets a function mutate the caller's value, and the call says so: an argument
bound to a `&mut` parameter is written `&mut n`.

```milo
fn double(x: &mut i32) {
    x *= 2
}

var n: i32 = 21
double(&mut n)          // n is now 42; the &mut is the one thing this call can change
```

Reading `double(&mut n)` tells you `n` may be different afterwards without opening
`double`. A bare `double(n)` is a compile error, and `bun scripts/explicit-mut.ts <file>`
rewrites an older file. The marker goes on the argument, not the receiver: `v.push(1)` stays
as it is, because a method call already names the value it works on.

## Auto-borrow

Shared borrows stay implicit. You write `greet(u)` not `greet(&u)`: a read cannot change
anything you care about, so there is nothing to mark.

```milo
fn greet(user: &User): string {
    return "hi, " + user.name
}

let u = User { name: "Alice", age: 30 }
print(greet(u))        // auto-borrows u
print("age: ", u.age)  // u is still valid
```

## Isn't this too restrictive?

In practice, the overwhelming majority of references are function arguments — "give me this value briefly, I won't keep it." The rare cases where you'd want to store a reference (iterators, self-referential structs) are handled differently: owned data, Vec indices, or [generational arenas](/stdlib/). [Patterns Without Lifetimes](/language/patterns) has the shape-by-shape translation.

The tradeoff: a much simpler mental model and zero annotation overhead for the 95% case.

This isn't a fringe position. Graydon Hoare, Rust's creator, [wrote](https://graydon2.dreamwidth.org/307291.html) that he "wanted `&` to be a 'second-class' parameter-passing mode, not a first-class type, and I still think this is the sweet spot for the feature" — "I didn't think you should be able to return `&` from a function or put it in a structure." That is exactly Milo's rule. Rust shipped first-class references and can't walk that back now; Milo took the design Rust's own author wanted.
