# Concurrency

Milo has two concurrency layers: OS threads for CPU-bound parallelism, and green threads for high-concurrency I/O. No `async`/`await` — blocking code runs concurrently in green threads automatically.

## OS Threads

### Spawning Threads

Use `spawn()` with a `move` closure to run code on a new OS thread:

```milo
from "std/thread" import { spawn, threadJoin, Thread }

let t = spawn(move (): void => {
    print("hello from thread")
})!
threadJoin(t)!
```

Move closures are required for `spawn` — they heap-allocate captured variables so they're safe to send across threads.

```milo
from "std/thread" import { spawn, threadJoin, Thread }

var threads: Vec<Thread> = Vec.new()
for i in 0..4 {
    let id = i as i64
    let t = spawn(move (): void => {
        print($"thread {id}")
    })!
    threads.push(t)
}
for i in 0..4 {
    threadJoin(threads[i])!
}
```

### Thread Safety (Send / Sync)

The compiler enforces thread safety at compile time. `spawn()` requires all captured variables to implement `Send`.

**Send types** (safe to move to another thread): all primitives, `string`, `Box<T>`, `Vec<T>`, `HashMap<K,V>`, structs/enums where all fields are Send, and any struct annotated with `@send`.

**Sync types** (safe to share via `&T` across threads): same rules, checked via `@sync`.

```milo
// Compiles — i64 and string are Send
let msg = "hello"
let t = spawn(move (): void => { print(msg) })!

// Compile error — *u8 is not Send
var x: i32 = 42
unsafe {
    let p = (&x) as *u8
    let t = spawn(move (): void => {    // error: cannot send 'p' of type '*u8'
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

### Channels

Bounded FIFO channels for message passing between threads:

```milo
from "std/thread" import { spawn, threadJoin, Thread }
from "std/sync" import { channelNew, channelSend, channelRecv, channelDestroy }

let ch = channelNew(8)!

let t = spawn(move (): void => {
    channelSend(ch, 10)!
    channelSend(ch, 20)!
    channelSend(ch, 0)!   // sentinel
})!

while true {
    let val = channelRecv(ch)!
    if val == 0 { break }
    print(val)
}
threadJoin(t)!
channelDestroy(ch)
```

Non-blocking variants:

```milo
from "std/sync" import { channelNew, channelTrySend, channelTryRecv, channelLen }

let ch = channelNew(4)!
channelTrySend(ch, 42)       // returns true if sent, false if full
let val = channelTryRecv(ch)  // returns Option<i64>
match val {
    Option.Some(v) => { print(v) }
    Option.None => { print("empty") }
}
```

### Mutex and RwLock

```milo
from "std/sync" import { mutexNew, withLock, mutexDestroy }

let m = mutexNew()!
var x: i64 = 0
withLock(m, (): void => {
    x = 42
})!
mutexDestroy(m)
```

Reader-writer lock for multiple concurrent readers OR one exclusive writer:

```milo
from "std/sync" import { rwLockNew, withReadLock, withWriteLock, rwLockDestroy }

let rw = rwLockNew()!
withReadLock(rw, (): void => { /* read shared data */ })!
withWriteLock(rw, (): void => { /* write shared data */ })!
rwLockDestroy(rw)
```

### Atomics

Lock-free atomic types for cross-thread counters and flags:

```milo
from "std/sync" import { atomicI64New, atomicI64Load, atomicI64Add, atomicI64Cas, atomicI64Destroy }

let counter = atomicI64New(0)
atomicI64Add(counter, 1)
print(atomicI64Load(counter))   // 1
atomicI64Destroy(counter)
```

All operations use sequential consistency. `AtomicI64` and `AtomicBool` are `@send` + `@sync`.

## Green Threads

Lightweight user-space threads. Each gets a 64KB stack instead of ~8MB for an OS thread — run thousands concurrently.

### Spawning Green Threads

```milo
from "std/runtime" import { greenSpawn }

fn main(): i32 {
    greenSpawn(move (): void => {
        print("hello from green thread")
    })
    return 0
}
```

The compiler injects a scheduler drain at the end of `main` that runs all spawned green threads to completion.

### Cooperative Yielding

```milo
from "std/runtime" import { greenSpawn, schedulerYield }

fn main(): i32 {
    greenSpawn(move (): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    greenSpawn(move (): void => {
        print("B1")
        schedulerYield()
        print("B2")
    })
    return 0
}
// Output: A1, B1, A2, B2
```

### Transparent Async I/O

`tcpRecv` and `tcpSend` from `std/net` automatically detect green thread context. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

```milo
from "std/net" import { tcpConnect, tcpSend, tcpRecv }
from "std/runtime" import { greenSpawn }

greenSpawn(move (): void => {
    let stream = tcpConnect(ip, port)!
    tcpSend(stream, "hello")!      // yields if socket buffer full
    let data = tcpRecv(stream)!    // yields until data arrives
    print(data)
})
```

The same calls work identically outside green threads — they just block normally.

### Comparison

| | OS Thread (`spawn`) | Green Thread (`greenSpawn`) |
|---|---|---|
| Stack size | ~8MB | 64KB |
| Context switch | Kernel | Userspace |
| Max concurrent | ~hundreds | thousands |
| Best for | CPU-bound parallelism | I/O-bound concurrency |
