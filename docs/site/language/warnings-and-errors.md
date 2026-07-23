# Warnings & Errors

Milo's compiler catches bugs before your code runs. Errors stop compilation. Warnings flag code that compiles but is probably wrong. Both come with source locations, carets pointing at the problem, and hints telling you how to fix it.

## Errors

Errors are things that *will* break at runtime — the compiler won't let them through.

### Use after move

```milo
let a = "hello"
let b = a
print(a)           // error: use of moved variable 'a'
```

```
error: use of moved variable 'a'
  --> example.milo:3:7
  |
3 |     print(a)
  |           ^
  hint: ownership of 'a' was transferred earlier and it can no longer
        be used here. To keep it alive, clone it at the point of
        transfer: 'a.clone()'.
```

### Move out of loop

```milo
let s = "hello"
while true {
    consume(s)     // error: cannot move 's' out of a loop
}
```

On the first iteration `s` would be gone — the second iteration would be a use-after-move. The compiler catches this statically.

### Assign to immutable

```milo
let x: i32 = 5
x = 10             // error: cannot assign to immutable variable 'x'
```

```
  hint: declare with 'var' instead of 'let' to make it mutable
```

### Type mismatches

```milo
let x: i32 = "hello"   // error: type mismatch: 'x' declared as i32 but got string
```

### Storing references

```milo
struct Bad {
    ref: &string       // error: references cannot be stored in structs
}
```

```
  hint: references are second-class — use an owned type instead
```

### Returning references

```milo
fn bad(): &string {    // error: cannot return a reference
    ...
}
```

Same rule — references live only as long as the function call. Return an owned value instead.

## Warnings

Warnings won't stop compilation, but they usually mean something is wrong.

### unused-variable

```milo
let x = compute()     // warning: unused variable 'x'
```

```
  hint: prefix with '_' to suppress: '_x'
```

### unused-result

Ignoring a `Result` or `Option` is almost always a bug — it may contain an error you should handle.

```milo
fs.readFile("data.txt")   // warning: unused Result value — this may contain an error
```

```
  hint: use 'let _ = ...' to discard explicitly
```

### bare-embedfile

`embedFile("path")` reads like an ordinary function call, but it is compile-time-only: the argument has to be a string literal and the file is read and inlined while compiling. `@` is how Milo already marks compiler-level constructs (`@cLayout`, `@cSig`, `@link`), so the embed builtin takes it too.

```milo
let html = embedFile("index.html")    // warning: 'embedFile' is a compile-time builtin
let html = @embedFile("index.html")   // preferred
```

```
  hint: the '@' marks it as compiler magic, not a runtime call
```

The bare form still compiles and behaves identically.

### unused-move

An owned parameter that's never moved might not need ownership. This is off by default.

```milo
fn process(data: string): i64 {   // warning: parameter 'data' is never moved
    return data.len                //   hint: consider taking '&string' instead
}
```

### large-stack-array

A fixed-size local array is a stack allocation of its full size, up front — a big one can silently overflow the stack (worst on secondary threads and in deep recursion). Off by default, since many are intentional; opt in with `--deny=large-stack-array`. The threshold defaults to 512 KiB and is tunable with `--max-stack-array` (accepts a `k`/`m` suffix, e.g. `--max-stack-array=256k`).

```milo
var fb: [u32; 172800] = [0; 172800]   // warning: 'fb' is a 675 KiB stack allocation
                                       //   hint: use Vec<u32> for a heap buffer
```

## Configuring warnings

Use `--deny` to turn a warning into a hard error, `--allow` to suppress it, or `--deny-all` to treat every warning as an error.

```bash
# treat unused variables as errors
milo build app.milo --deny=unused-variable

# suppress unused result warnings
milo build app.milo --allow=unused-result

# strict mode: all warnings are errors
milo build app.milo --deny-all
```

| Warning code | Default | What it catches |
|---|---|---|
| `unused-variable` | warn | Declared but never read |
| `unused-result` | warn | `Result` or `Option` value silently discarded |
| `bare-embedfile` | warn | `embedFile(...)` written without its `@` sigil |
| `unused-move` | allow | Owned param never moved — could be a borrow instead |
| `large-stack-array` | allow | Local fixed array over `--max-stack-array` (default 512 KiB) — stack-overflow risk |

## Error formatting

Every diagnostic includes:

- **Source location** — file, line, and column
- **Caret** — points at the exact token
- **Hint** — actionable fix suggestion

```
error: use of moved variable 'name'
  --> src/main.milo:12:11
   |
12 |     print(name)
   |           ^
   hint: ownership of 'name' was transferred earlier and it can no
         longer be used here. To keep it alive, clone it at the point
         of transfer: 'name.clone()'.
```

Inspired by Elm and Rust's error style — clear enough that you rarely need to search for what went wrong.

Next: [Collections →](./collections)
