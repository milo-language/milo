# std/thread

Safe concurrency with OS threads. `spawn` requires a `move` closure — captured variables transfer ownership into the thread, so there's no shared mutable state and no data races by construction. No `unsafe`, no `Arc`, no lifetime annotations. Pair with `std/sync` for channels and mutexes when threads need to communicate.

```milo
from "std/thread" import { spawn, threadJoin, threadSleep }
```

## Types

### Thread

```milo
struct Thread {
    id: i64,
}
```

Handle to a spawned OS thread.

## Functions

### spawn

```milo
fn spawn(f: () => void): Result<Thread>
```

Spawn a new thread running the given closure. The closure must use `move` semantics — captured variables are heap-allocated and moved into the thread.

### threadSpawn

```milo
fn threadSpawn(func: *u8, arg: *u8): Result<Thread>
```

Low-level thread creation with raw function and argument pointers. Requires `unsafe`.

### threadSpawnFn

```milo
fn threadSpawnFn(f: (*u8) => *u8): Result<Thread>
```

Spawn a thread from a no-arg function pointer. Requires `unsafe`.

### threadJoin

```milo
fn threadJoin(t: &Thread): Result<i32>
```

Block until the thread finishes.

### threadSleep

```milo
fn threadSleep(ms: i64): void
```

Sleep the current thread for `ms` milliseconds.

## Example

```milo
from "std/thread" import { spawn, threadJoin }

fn main(): i32 {
    let msg = "hello from thread"
    let val: i64 = 42

    let t = spawn(move (): void => {
        print(msg)
        print($"value is {val}")
    })!

    threadJoin(t)!
    print("done")
    return 0
}
```
