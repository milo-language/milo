# Quickstart

## Your first program

Create `hello.milo`:

```milo
fn main(): i32 {
    print("hello, world!")
    return 0
}
```

Every Milo program starts at `main`, which returns an `i32` exit code.

## Run it

```bash
bun run src/main.ts run hello.milo
```

The `run` command compiles and executes in one step — no artifacts left behind.

## Build a binary

```bash
bun run src/main.ts build hello.milo -o hello
./hello
```

The binary is standalone — no runtime needed. Typically under 300KB.

## Build modes

```bash
bun run src/main.ts build app.milo -o app            # default: -O2
bun run src/main.ts build app.milo -o app --release   # -O3
bun run src/main.ts build app.milo -o app --debug     # -O0
bun run src/main.ts build app.milo -o app -g --debug  # -O0 + DWARF, for lldb
```

`-g` emits DWARF debug info and composes with any optimization level. See [Debugging](/getting-started/debugging).

## See the LLVM IR

```bash
bun run src/main.ts emit-ir hello.milo
```

Useful for understanding what the compiler generates.

## Run the test suite

```bash
bun test
```

## Something more interesting

Create `greet.milo`:

```milo
struct User {
    name: string,
    age: i32,
}

fn greet(user: &User): string {
    return "hi, " + user.name + "!"
}

fn main(): i32 {
    let u = User { name: "Alice", age: 30 }
    print(greet(u))
    print("age: ", u.age)
    return 0
}
```

```bash
$ bun run src/main.ts run greet.milo
hi, Alice!
age: 30
```

`&User` borrows the value without consuming it — `u` is still usable after the call. Milo auto-borrows at call sites, so you write `greet(u)` not `greet(&u)`.

Next: [IDE Setup →](./ide-setup) or jump to [Variables & Types →](/language/variables)
