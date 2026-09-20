# Closures

Closures are anonymous functions that capture variables from the surrounding scope. The syntax is `(params) => expression`:

```milo
fn apply(f: (i32) => i32, x: i32): i32 {
    return f(x)
}

let result = apply((x: i32) => x * 2, 21)   // 42
```

Milo has two kinds:

- **Regular closures** capture by reference. Non-escaping: you can pass them around, but not return them from a function or store them in a struct. Captured references are always valid.
- **Move closures** take ownership of captured variables. Because they own everything, they *can* be returned, stored, and sent to other threads.

## Block closures

More than one line needs a block body. `return` is explicit:

```milo
fn apply(f: (i32) => i32, x: i32): i32 {
    return f(x)
}

let result = apply((x: i32): i32 => {
    let doubled = x * 2
    return doubled + 1
}, 20)   // 41
```

## Variables and callbacks

Closures can be stored in local variables:

```milo
let inc = (x: i32) => x + 1
print(inc(5))   // 6
```

Any function that accepts a `(...) => ...` parameter can take a closure:

```milo
fn doTwice(f: () => void) {
    f()
    f()
}

doTwice(() => print("hello"))
// prints "hello" twice
```

## Capturing and mutation

Regular closures capture by reference, so mutations are visible outside:

```milo
fn callIt(f: () => void) {
    f()
}

var count: i32 = 0
callIt(() => { count = count + 1 })
callIt(() => { count = count + 1 })
print(count)   // 2
```

## Type inference

Parameter types are inferred when context makes them unambiguous:

```milo
var v: Vec<i32> = Vec.new()
v.push(1)
v.push(2)
v.push(3)

let doubled = v.map((x) => x * 2)       // x inferred as i32
let big = v.filter((x) => x > 1)         // x inferred as &i32
```

Collections and closures compose:

```milo
var nums: Vec<i32> = Vec.new()
nums.push(1)
nums.push(2)
nums.push(3)
nums.push(4)

let doubled = nums.map((n) => n * 2)
let evenSquares = nums.filter((n) => n % 2 == 0).map((n) => n * n)
```

## Move closures

Regular closures borrow from their environment, so they cannot outlive their creating scope. Prefix with `move` to take ownership instead:

```milo
fn makeAdder(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x + n
    }
}

fn main(): i32 {
    let add5 = makeAdder(5)
    print(add5(3))    // 8
    print(add5(10))   // 15
    return 0
}
```

Without `move`, this would be a compile error: `n` would be a dangling reference once `makeAdder` returns.

### Concurrency

Move closures are required for spawning tasks and threads, since the closure must own its data:

```milo
from "std/runtime" import { Task }

let t = Task.spawn(move (): void => {
    print("running in a task")
})
t.join()
```

`Promise.blocking` runs on a real OS thread, so captures must also be `Send`. See [Concurrency](/features/concurrency).

### When to use `move`

| Situation | Use |
|-----------|-----|
| Callback in the same scope, `.map()`, `.filter()` | Regular closure |
| Returning a closure from a function | `move` closure |
| Spawning a task or thread | `move` closure |
| Storing a closure for later in a different scope | `move` closure |

## Non-escaping restriction

Regular closures cannot be returned from functions or stored in structs. This keeps the ownership model simple and guarantees captured references are valid. When you need a closure that escapes, use `move`.

Next: [Modules](./modules)
