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
./milo run hello.milo
```

The `run` command compiles and executes in one step — no artifacts left behind.

## Build a binary

```bash
./milo build hello.milo -o hello
./hello
```

The binary is standalone — no runtime needed. Typically under 300KB.

## Build modes

```bash
./milo build app.milo -o app            # default: -O2
./milo build app.milo -o app --release   # -O3
./milo build app.milo -o app --debug     # -O0
./milo build app.milo -o app -g --debug  # -O0 + DWARF, for lldb
```

`-g` emits DWARF debug info and composes with any optimization level. See [Debugging](/getting-started/debugging).

## Runtime dependencies

A Milo binary links libc and nothing else — no runtime, no GC, no shared Milo library. Native
libraries are linked only when you actually use them: OpenSSL for `std/net` TLS, sqlite for
`std/sqlite`. Check with `otool -L app` (macOS) or `ldd app` (Linux).

Programs that use TLS link OpenSSL dynamically by default, so they pick up system security
fixes without a rebuild — but they then need OpenSSL installed wherever they run. To ship one
of those to a machine that may not have it:

```bash
./milo build app.milo -o app --static-deps   # bakes in openssl/sqlite; libc-only binary
```

The tradeoff is size (roughly +5MB) and losing system security updates for the baked-in
copy — a CVE means rebuilding and redistributing. Programs that don't use TLS or sqlite need
neither the flag nor the thought.

## See the LLVM IR

```bash
./milo emit-ir hello.milo
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
$ ./milo run greet.milo
hi, Alice!
age: 30
```

`&User` borrows the value without consuming it — `u` is still usable after the call. Milo auto-borrows at call sites, so you write `greet(u)` not `greet(&u)`.

Next: [IDE Setup →](./ide-setup) or jump to [Variables & Types →](/language/variables)
