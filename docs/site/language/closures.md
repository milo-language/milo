# Closures

Arrow syntax, non-escaping. Closures can be passed as arguments or stored in local variables, but cannot be returned or stored in structs.

## Expression closures

```milo
fn apply(f: fn(i32): i32, x: i32): i32 {
    return f(x)
}

let result = apply((x: i32) => x * 2, 21)   // 42
```

## Block closures

```milo
let result = apply((x: i32): i32 => {
    let doubled = x * 2
    return doubled + 1
}, 20)   // 41
```

## Stored in variables

```milo
let inc = (x: i32) => x + 1
print(inc(5))   // 6
```

## Capturing variables

Closures capture by reference — mutations are visible outside:

```milo
fn callIt(f: fn(): void) {
    f()
}

var count: i32 = 0
callIt(() => { count = count + 1 })
callIt(() => { count = count + 1 })
print(count)   // 2
```

## Limitations

Closures are non-escaping: they cannot be returned from functions or stored in structs. This keeps the ownership model simple — captured references are always valid.

Next: [Modules →](./modules)
