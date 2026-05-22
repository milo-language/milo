# Concurrency

Milo gives you two concurrency layers: **green threads** (lightweight cooperative tasks) and **OS threads** (real parallelism). There is no `async`/`await` — you write blocking code, and the runtime runs it concurrently.

For most concurrent work, reach for `Promise<T>`. Drop to green threads, OS threads, or channels when you need more control.

## Promises

A `Promise<T>` runs a function on a green thread and delivers the result. It's the simplest way to do work concurrently.

### Basic Promise

```milo
from "std/runtime" import { Promise }

let p = Promise((): i64 => {
    return expensiveComputation()
})
let result = p.await()!
```

`Promise(fn)` is shorthand for `Promise<T>.run(fn)` — the return type is inferred from the closure. Call `.await()!` to block until the result is ready.

### Captured Variables and Auto-Move

When a closure captures variables, the compiler automatically infers `move` — captured values are moved into the promise so they're safe to use on another green thread:

```milo
from "std/runtime" import { Promise }

let msg = "hello world"
let p = Promise((): string => {
    return msg    // msg is auto-moved into the closure
})
print(p.await()!)   // hello world
```

You can write `move` explicitly, but it's inferred for `Promise(fn)` and `Thread.spawn()`.

### Promise.all — Run N Tasks, Collect All Results

`Promise.all()` takes a vector of promises and returns a single promise that resolves to a vector of all results, preserving order:

```milo
from "std/runtime" import { Promise }

fn compute(n: i64): i64 {
    return n * 10
}

fn main(): i32 {
    var promises: Vec<Promise<i64>> = Vec.new()
    promises.push(Promise((): i64 => { return compute(10) }))
    promises.push(Promise((): i64 => { return compute(20) }))

    let results = Promise.all(promises).await()!
    for r in results {
        print(r)    // 100, 200
    }
    return 0
}
```

### Promise.race — First Result Wins

`Promise.race()` returns the first promise to complete and discards the rest:

```milo
from "std/runtime" import { Promise }

var promises: Vec<Promise<i64>> = Vec.new()
promises.push(Promise((): i64 => 10))
promises.push(Promise((): i64 => 20))
promises.push(Promise((): i64 => 30))

let first = Promise.race(promises).await()!
print(first)    // whichever finishes first
```

### Practical: Parallel HTTP Fetches

Fetch multiple URLs concurrently and collect all responses:

```milo
from "std/runtime" import { Promise }
from "std/net" import { TcpStream }

fn fetchUrl(host: string, path: string): string {
    let stream = TcpStream.connect(host, 80)!
    stream.send($"GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")!
    return stream.recv()!
}

fn main(): i32 {
    var promises: Vec<Promise<string>> = Vec.new()
    promises.push(Promise((): string => { return fetchUrl("example.com", "/api/users") }))
    promises.push(Promise((): string => { return fetchUrl("example.com", "/api/posts") }))
    promises.push(Promise((): string => { return fetchUrl("example.com", "/api/comments") }))

    let responses = Promise.all(promises).await()!
    for resp in responses {
        print(resp)
    }
    return 0
}
```

Each fetch runs on its own green thread. The runtime handles non-blocking I/O transparently — `TcpStream` yields on EAGAIN and resumes when data arrives.

### Practical: Timeout Pattern

Use `Promise.race()` to add a timeout to any operation:

```milo
from "std/runtime" import { Promise }
from "std/time" import { sleepMs }

fn slowOperation(): string {
    sleepMs(5000)
    return "done"
}

fn main(): i32 {
    var promises: Vec<Promise<string>> = Vec.new()
    promises.push(Promise((): string => { return slowOperation() }))
    promises.push(Promise((): string => {
        sleepMs(1000)
        return "timeout"
    }))

    let result = Promise.race(promises).await()!
    if result == "timeout" {
        print("operation timed out")
    } else {
        print(result)
    }
    return 0
}
```

### Practical: Fan-Out / Fan-In

Spawn N workers, each processing a chunk of work, then combine results:

```milo
from "std/runtime" import { Promise }
from "std/time" import { sleepMs }

fn processChunk(id: i64, data: i64): i64 {
    sleepMs(100)    // simulate work
    return data * 2
}

fn main(): i32 {
    var promises: Vec<Promise<i64>> = Vec.new()

    var i: i64 = 1
    while i <= 3 {
        let val = i * 20
        promises.push(Promise((): i64 => {
            return processChunk(i, val)
        }))
        i = i + 1
    }

    let results = Promise.all(promises).await()!
    var sum: i64 = 0
    for r in results {
        sum += r
    }
    print("total: ", sum)   // total: 240
    return 0
}
```

## Green Threads

For fire-and-forget work that doesn't return a value, use `Task.spawn()`. Green threads use 64KB stacks (vs ~8MB for OS threads), so you can run thousands concurrently.

```milo
from "std/runtime" import { Task }

fn main(): i32 {
    Task.spawn((): void => {
        print("hello from green thread")
    })
    return 0
}
```

The compiler injects a scheduler drain at the end of `main` that runs all spawned tasks to completion.

### Cooperative Yielding

Green threads yield cooperatively. Use `schedulerYield()` to give other tasks a chance to run:

```milo
from "std/runtime" import { Task, schedulerYield }

fn main(): i32 {
    Task.spawn((): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    Task.spawn((): void => {
        print("B1")
        schedulerYield()
        print("B2")
    })
    return 0
}
// Output: A1, B1, A2, B2
```

### Transparent Async I/O

`TcpStream` operations automatically detect green thread context. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

```milo
from "std/net" import { TcpStream }
from "std/runtime" import { Task }

Task.spawn((): void => {
    let stream = TcpStream.connect(ip, port)!
    stream.send("hello")!          // yields if socket buffer full
    let data = stream.recv()!      // yields until data arrives
    print(data)
})
```

The same calls work identically outside green threads — they just block normally.

## OS Threads

For CPU-bound parallelism that benefits from multiple cores, use `Thread.spawn()`. The compiler automatically infers `move` for thread closures:

```milo
from "std/thread" import { Thread }

let t = Thread.spawn((): void => {
    print("hello from thread")
})!
t.join()!
```

Spawn multiple threads and join them:

```milo
from "std/thread" import { Thread }

var threads: Vec<Thread> = Vec.new()
for i in 0..4 {
    let id = i as i64
    let t = Thread.spawn((): void => {
        print($"thread {id}")
    })!
    threads.push(t)
}
for i in 0..4 {
    threads[i].join()!
}
```

### Thread Safety (Send / Sync)

`Thread.spawn()` requires all captured variables to implement `Send`. The compiler enforces this at compile time.

**Send types** (safe to move to another thread): all primitives, `string`, `Heap<T>`, `Vec<T>`, `HashMap<K,V>`, structs/enums where all fields are Send, and any struct annotated with `@send`.

**Sync types** (safe to share via `&T` across threads): same rules, checked via `@sync`.

```milo
// Compiles — i64 and string are Send
let msg = "hello"
let t = Thread.spawn((): void => { print(msg) })!

// Compile error — *u8 is not Send
var x: i32 = 42
unsafe {
    let p = (&x) as *u8
    let t = Thread.spawn((): void => {    // error: cannot send 'p' of type '*u8'
        print(p as i64)
    })!
}
```

## Channels

Bounded FIFO channels for streaming values between threads. Use channels when a producer sends many values over time — for one-shot results, prefer `Promise`.

```milo
from "std/thread" import { Thread }
from "std/sync" import { Channel }

var ch = Channel<i64>.new(8)!

let t = Thread.spawn(move (): void => {
    ch.send(10)!
    ch.send(20)!
    ch.close()
})!

for val in ch {
    print(val)
}
t.join()!
ch.destroy()
```

Call `close()` to signal no more values — remaining items are delivered before iteration ends. Non-blocking variants are also available:

```milo
ch.trySend(42)       // returns true if sent, false if full
ch.tryRecv()         // returns Option<T> — None if empty
```

## Shared State

### Mutex

```milo
from "std/sync" import { Mutex }

let m = Mutex.new()!
var x: i64 = 0
m.withLock((): void => {
    x = 42
})!
m.destroy()
```

### RwLock

Multiple concurrent readers OR one exclusive writer:

```milo
from "std/sync" import { RwLock }

let rw = RwLock.new()!
rw.withReadLock((): void => { /* read shared data */ })!
rw.withWriteLock((): void => { /* write shared data */ })!
rw.destroy()
```

### Atomics

Lock-free atomic types for cross-thread counters and flags. All operations use sequential consistency.

```milo
from "std/sync" import { AtomicI64 }

let counter = AtomicI64.new(0)
counter.add(1)
print(counter.load())   // 1
counter.destroy()
```

`AtomicI64` and `AtomicBool` are `@send` + `@sync`.

## Which to Use

| Need | Reach for |
|------|-----------|
| Run something and get a result back | `Promise(fn)` |
| Run N things, collect all results | `Promise.all()` |
| First-to-finish wins, or timeout | `Promise.race()` |
| Fire-and-forget background work | `Task.spawn()` |
| Stream many values between threads | `Channel<T>` with `close()` + `for val in ch` |
| CPU-heavy work on dedicated OS threads | `Thread.spawn()` |
| Shared mutable state | `Mutex` or `RwLock` |
| Lock-free counters / flags | `AtomicI64`, `AtomicBool` |

Start with `Promise`. Drop to channels or threads when you need streaming or OS-level control.
