# Concurrency

Milo has two concurrency layers: OS threads for CPU-bound parallelism, and green threads for high-concurrency I/O. No `async`/`await` — blocking code runs concurrently in green threads automatically.

## OS Threads

### Spawning Threads

Use `Thread.spawn()` with a closure to run code on a new OS thread. The compiler automatically infers `move` — the closure takes ownership of captured variables so they're safe to send across threads:

```milo
from "std/thread" import { Thread }

let t = Thread.spawn((): void => {
    print("hello from thread")
})!
t.join()!
```

Move closures heap-allocate captured variables so they're safe to send across threads. You can write `move` explicitly, but it's inferred when the function takes an owned closure.

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

The compiler enforces thread safety at compile time. `Thread.spawn()` requires all captured variables to implement `Send`.

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

Use `@send` and `@sync` annotations for types with unsafe internals:

```milo
@send
@sync
struct MyHandle {
    _ptr: *u8,
}
```

### Parallel Blocks

Run multiple expressions concurrently and collect all results:

```milo
fn expensiveA(): i64 { return 42 }
fn expensiveB(): i64 { return 99 }

parallel {
    let a = expensiveA()
    let b = expensiveB()
}
print(a + b)   // 141
```

Each branch runs on its own OS thread. Variables bound inside are available after the block.

### Promises

For most concurrent work, reach for `Promise<T>` — it runs a function on a green thread and returns the result:

```milo
from "std/runtime" import { Promise }

let p = Promise((): i64 => {
    return expensiveComputation()
})
let result = p.await()!
```

`Promise(fn)` is shorthand for `Promise<T>.run(fn)` — the type parameter is inferred from the closure's return type.

`Promise.all()` runs multiple tasks and collects results. `Promise.race()` returns the first to finish:

```milo
from "std/runtime" import { Promise }

var tasks: Vec<Promise<i64>> = Vec.new()
tasks.push(Promise((): i64 => { return fetchA() }))
tasks.push(Promise((): i64 => { return fetchB() }))

let results = Promise.all(tasks)   // [resultA, resultB]
```

### Channels

Bounded FIFO channels for streaming values between threads. Use channels when a producer sends many values over time — for one-shot results, prefer Promise.

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

### Mutex and RwLock

```milo
from "std/sync" import { Mutex }

let m = Mutex.new()!
var x: i64 = 0
m.withLock((): void => {
    x = 42
})!
m.destroy()
```

Reader-writer lock for multiple concurrent readers OR one exclusive writer:

```milo
from "std/sync" import { RwLock }

let rw = RwLock.new()!
rw.withReadLock((): void => { /* read shared data */ })!
rw.withWriteLock((): void => { /* write shared data */ })!
rw.destroy()
```

### Atomics

Lock-free atomic types for cross-thread counters and flags:

```milo
from "std/sync" import { AtomicI64 }

let counter = AtomicI64.new(0)
counter.add(1)
print(counter.load())   // 1
counter.destroy()
```

All operations use sequential consistency. `AtomicI64` and `AtomicBool` are `@send` + `@sync`.

## Green Threads

Lightweight user-space threads. Each gets a 64KB stack instead of ~8MB for an OS thread — run thousands concurrently.

### Spawning Green Threads

```milo
from "std/runtime" import { Task }

fn main(): i32 {
    Task.spawn((): void => {
        print("hello from green thread")
    })
    return 0
}
```

The compiler injects a scheduler drain at the end of `main` that runs all spawned green threads to completion.

### Cooperative Yielding

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

`stream.recv()` and `stream.send()` from `std/net` automatically detect green thread context. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

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

### Comparison

| | OS Thread (`Thread.spawn`) | Green Thread (`Task.spawn`) |
|---|---|---|
| Stack size | ~8MB | 64KB |
| Context switch | Kernel | Userspace |
| Max concurrent | ~hundreds | thousands |
| Best for | CPU-bound parallelism | I/O-bound concurrency |

## Which to Use

| Need | Reach for |
|------|-----------|
| Run something and get a result back | `Promise<T>` |
| Run N things concurrently, collect results | `Promise.all()` |
| Stream many values between threads | `Channel<T>` with `close()` + `for val in ch` |
| CPU-heavy work on a dedicated OS thread | `Thread.spawn()` |
| Shared mutable state | `Mutex` or `RwLock` |

Start with `Promise`. Drop to channels or threads when you need streaming or OS-level control.
