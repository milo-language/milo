# Closures

If you've used arrow functions in JavaScript, lambdas in Python, or anonymous functions in Go, closures will feel familiar. A closure is a function without a name that can capture variables from the surrounding scope.

Milo has two kinds of closures:

- **Regular closures** capture variables by reference. They are *non-escaping* — you can pass them around or store them in local variables, but you cannot return them from a function or store them in a struct. This guarantees that captured references are always valid.
- **Move closures** take ownership of their captured variables. Because they own everything they close over, they *can* be returned, stored, and sent to other threads.

Let's start with regular closures.

## Expression closures

The simplest closure is a one-liner. The syntax is `(params) => expression` — the return value is the expression itself, no `return` needed.

```milo
fn apply(f: fn(i32): i32, x: i32): i32 {
    return f(x)
}

let result = apply((x: i32) => x * 2, 21)   // 42
```

## Block closures

When you need more than one line, use a block body with curly braces. You must `return` explicitly.

```milo
let result = apply((x: i32): i32 => {
    let doubled = x * 2
    return doubled + 1
}, 20)   // 41
```

## Stored in variables

Closures can be stored in local variables and called later — just like any other value.

```milo
let inc = (x: i32) => x + 1
print(inc(5))   // 6
```

## Capturing variables

Closures can read and write variables from the enclosing scope. Regular closures capture by reference, so mutations inside the closure are visible outside.

```milo
fn callIt(f: fn(): void) {
    f()
}

var count: i32 = 0
callIt(() => { count = count + 1 })
callIt(() => { count = count + 1 })
print(count)   // 2
```

## Type inference

When the compiler can figure out parameter types from context (for example, from `Vec.map` or `Vec.filter`), you can omit them.

```milo
var v: Vec<i32> = Vec.new()
v.push(1)
v.push(2)
v.push(3)

let doubled = v.map((x) => x * 2)       // x inferred as i32
let big = v.filter((x) => x > 1)         // x inferred as &i32
```

## Practical usage: map, filter, callbacks

Closures really shine when combined with collections. Passing a closure to `.map()` or `.filter()` lets you transform or select data in a single expression.

```milo
var nums: Vec<i32> = Vec.new()
nums.push(1)
nums.push(2)
nums.push(3)
nums.push(4)

// double every element
let doubled = nums.map((n) => n * 2)

// keep only even numbers, then square them
let evenSquares = nums.filter((n) => n % 2 == 0).map((n) => n * n)
```

Closures also work well as callbacks. Any function that accepts a `fn(...): ...` parameter can take a closure.

```milo
fn doTwice(f: fn(): void) {
    f()
    f()
}

doTwice(() => print("hello"))
// prints "hello" twice
```

## Move closures

Regular closures borrow from their environment, which means they cannot outlive the scope they were created in. When you need a closure that *owns* its data -- to return it from a function, store it in a data structure, or send it to another thread -- prefix it with `move`.

A move closure transfers ownership of every captured variable into the closure. The original variables are no longer available after the move.

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

Here, `makeAdder` returns a closure. The `move` keyword tells the compiler to take ownership of `n` rather than borrowing it. Without `move`, this would be a compile error because `n` would be a dangling reference once `makeAdder` returns.

### Sending closures to threads

Move closures are essential for concurrency. Because they own their data, there is no risk of dangling references across threads.

```milo
let t = Thread.spawn(move (): void => {
    print("running in another thread")
})
t.join()
```

### When to use `move`

| Situation | Use |
|-----------|-----|
| Passing a closure as a callback in the same scope | Regular closure |
| Calling `.map()`, `.filter()` on a collection | Regular closure |
| Returning a closure from a function | `move` closure |
| Spawning a thread or task | `move` closure |
| Storing a closure to call later in a different scope | `move` closure |

## Limitations of regular closures

Regular (non-`move`) closures are non-escaping: they cannot be returned from functions or stored in structs. This is by design -- it keeps the ownership model simple and guarantees that captured references are always valid. If you need a closure that escapes, reach for `move`.

Next: [Modules →](./modules)
