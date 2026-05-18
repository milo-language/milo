# std/thread

Safe concurrency with OS threads. `Thread.spawn()` requires a `move` closure — captured variables transfer ownership into the thread, so there's no shared mutable state and no data races by construction. No `unsafe`, no `Arc`, no lifetime annotations. Pair with `std/sync` for channels and mutexes when threads need to communicate.

```milo
from "std/thread" import { Thread }
```

## Quick start: parallel workers with a result channel

Fan out CPU work across threads, collect results through a channel — a common pattern for batch processing, parallel builds, or map-reduce style pipelines.

```milo
from "std/thread" import { Thread }
from "std/sync" import { Channel }

fn processChunk(id: i64, start: i64, end: i64, ch: Channel): void {
    var sum: i64 = 0
    var i: i64 = start
    while i < end {
        sum = sum + i
        i = i + 1
    }
    ch.send(sum)!
    print($"worker {id}: summed {start}..{end} = {sum}")
}

fn main(): i32 {
    let numWorkers: i64 = 4
    let total: i64 = 1000000
    let chunkSize: i64 = total / numWorkers

    let ch = Channel.new(numWorkers)!
    var threads: Vec<Thread> = Vec.new()

    var i: i64 = 0
    while i < numWorkers {
        let id = i
        let start = i * chunkSize
        let end = if i == numWorkers - 1 { total } else { start + chunkSize }
        let t = Thread.spawn(move (): void => {
            processChunk(id, start, end, ch)
        })!
        threads.push(t)
        i = i + 1
    }

    var result: i64 = 0
    i = 0
    while i < numWorkers {
        result = result + ch.recv()!
        i = i + 1
    }

    i = 0
    while i < numWorkers {
        threads[i].join()!
        i = i + 1
    }
    ch.destroy()

    print($"total: {result}")
    return 0
}
```

Each worker owns its data via `move` — the compiler won't let you accidentally share mutable state across threads. The channel is the only coordination point, and it's safe to pass between threads by design.

## Types

### Thread

```milo
struct Thread {
    id: i64,
}
```

Handle to a spawned OS thread.

## Methods

### Thread.spawn

```milo
fn Thread.spawn(f: () => void): Result<Thread>
```

Spawn a new thread running the given closure. The closure must use `move` semantics — captured variables are heap-allocated and moved into the thread.

### t.join

```milo
fn join(self: &Thread): Result<i32>
```

Block until the thread finishes.

### Thread.sleep

```milo
fn Thread.sleep(ms: i64): void
```

Sleep the current thread for `ms` milliseconds.

## Low-level Functions

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

## Example

```milo
from "std/thread" import { Thread }

fn main(): i32 {
    let msg = "hello from thread"
    let val: i64 = 42

    let t = Thread.spawn(move (): void => {
        print(msg)
        print($"value is {val}")
    })!

    t.join()!
    print("done")
    return 0
}
```
