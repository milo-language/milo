# Concurrency

Milo has two concurrency layers: OS threads for CPU-bound parallelism, and green threads for high-concurrency I/O. No `async`/`await` — blocking code runs concurrently in green threads automatically.

## OS Threads

### Spawning Threads

Use `Thread.spawn()` with a **move closure** to run code on a new OS thread. A move closure takes ownership of its captured variables instead of borrowing them — this is required because the new thread may outlive the scope where the variables were defined. The `move` keyword before the closure parameters signals this transfer:

```milo
from "std/thread" import { Thread }

let t = Thread.spawn(move (): void => {
    print("hello from thread")
})!
t.join()!
```

Move closures heap-allocate captured variables so they're safe to send across threads.

```milo
from "std/thread" import { Thread }

var threads: Vec<Thread> = Vec.new()
for i in 0..4 {
    let id = i as i64
    let t = Thread.spawn(move (): void => {
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

**Send types** (safe to move to another thread): all primitives, `string`, `Box<T>`, `Vec<T>`, `HashMap<K,V>`, structs/enums where all fields are Send, and any struct annotated with `@send`.

**Sync types** (safe to share via `&T` across threads): same rules, checked via `@sync`.

```milo
// Compiles — i64 and string are Send
let msg = "hello"
let t = Thread.spawn(move (): void => { print(msg) })!

// Compile error — *u8 is not Send
var x: i32 = 42
unsafe {
    let p = (&x) as *u8
    let t = Thread.spawn(move (): void => {    // error: cannot send 'p' of type '*u8'
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
from "std/thread" import { Thread }
from "std/sync" import { Channel }

let ch = Channel.new(8)!

let t = Thread.spawn(move (): void => {
    ch.send(10)!
    ch.send(20)!
    ch.send(0)!   // sentinel
})!

while true {
    let val = ch.recv()!
    if val == 0 { break }
    print(val)
}
t.join()!
ch.destroy()
```

Non-blocking variants:

```milo
from "std/sync" import { Channel }

let ch = Channel.new(4)!
ch.trySend(42)               // returns true if sent, false if full
let val = ch.tryRecv()        // returns Option<i64>
match val {
    Option.Some(v) => { print(v) }
    Option.None => { print("empty") }
}
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
from "std/runtime" import { GreenThread }

fn main(): i32 {
    GreenThread.spawn(move (): void => {
        print("hello from green thread")
    })
    return 0
}
```

The compiler injects a scheduler drain at the end of `main` that runs all spawned green threads to completion.

### Cooperative Yielding

```milo
from "std/runtime" import { GreenThread, schedulerYield }

fn main(): i32 {
    GreenThread.spawn(move (): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    GreenThread.spawn(move (): void => {
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
from "std/runtime" import { GreenThread }

GreenThread.spawn(move (): void => {
    let stream = TcpStream.connect(ip, port)!
    stream.send("hello")!          // yields if socket buffer full
    let data = stream.recv()!      // yields until data arrives
    print(data)
})
```

The same calls work identically outside green threads — they just block normally.

### Comparison

| | OS Thread (`Thread.spawn`) | Green Thread (`GreenThread.spawn`) |
|---|---|---|
| Stack size | ~8MB | 64KB |
| Context switch | Kernel | Userspace |
| Max concurrent | ~hundreds | thousands |
| Best for | CPU-bound parallelism | I/O-bound concurrency |
