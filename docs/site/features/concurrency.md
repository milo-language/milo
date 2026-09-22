# Concurrency

Milo has **one** concurrency model: **green tasks** on a cooperative, single-threaded scheduler, with **one OS-thread escape hatch** (`Promise.blocking`, which `std/shard`'s `parallelMap` family also runs on). There is no `async`/`await` and no function coloring: you write blocking code, and the runtime runs it concurrently.

`Task.spawn` runs a closure on the green scheduler; `Promise<T>`, `Channel`, `select`, and `WaitGroup` all park the *task*, not the OS thread, so they compose freely. Blocking I/O and channel operations yield to other tasks automatically; there is no event loop to run by hand. Real OS threads come from [`Promise.blocking`](#promise-blocking-cpu-bound-work-and-blocking-ffi), for CPU-bound parallelism and blocking FFI; `parallelMap` and `parallelMapWith` run each worker on one.

For most concurrent work, reach for `Promise<T>`.

## Which to Use

| Need | Use |
|------|-----|
| One-shot result off the main flow | `Promise(fn)` → `.await()!`; fan-out with `Promise.all`, first-wins with `Promise.race` |
| Stream of values over time | `Channel<T>` — producer `send`s + `close()`s, consumer `for val in ch` |
| Fleet of fire-and-forget workers | `Task.spawn` + `WaitGroup` |
| Wait on first-of-many sources | `std/select` |
| CPU-bound work or blocking FFI | `Promise.blocking(fn)` → `.await()!`; fan out across cores via `Promise.all` |
| Transform a big buffer across cores | `parallelMap(v, n, f)`: `std/shard` divides ownership, so nothing is copied and nothing is shared |
| Shared state across parallel workers | channels (pass ownership) or atomics (counters, flags) |

Most programs need only the first row. `Promise` is the familiar promise/await model with no event loop and no function coloring, and `await()` frees the promise's resources itself — there is nothing to `destroy()`.

## Promises

A `Promise<T>` runs a function on a green task and delivers the result. `Promise(fn)` is shorthand for `Promise<T>.run(fn)` — the return type is inferred from the closure:

```milo
from "std/runtime" import { Promise }

fn expensiveComputation(): i64 {
    return 42
}

let p = Promise((): i64 => {
    return expensiveComputation()
})
let result = p.await()!
```

Call `.await()!` to block until the result is ready. Promises run on green tasks with cooperative scheduling — no async/await coloring, no event loop. Blocking I/O automatically yields to other tasks.

### Captured Variables and Auto-Move

When a closure captures variables, the compiler automatically infers `move` for `Promise(fn)` — captured values are moved into the promise so they're safe to use on another green task:

```milo
from "std/runtime" import { Promise }

let msg = "hello world"
let p = Promise((): string => {
    return msg    // msg is auto-moved into the closure
})
print(p.await()!)   // hello world
```

You can write `move` explicitly, and `Promise.blocking` requires it (its closure crosses to a real thread).

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

fn main(): i32 {
    var promises: Vec<Promise<i64>> = Vec.new()
    promises.push(Promise((): i64 => { return 10 }))
    promises.push(Promise((): i64 => { return 20 }))
    promises.push(Promise((): i64 => { return 30 }))

    let first = Promise.race(promises).await()!
    print(first)    // whichever finishes first
    return 0
}
```

### Practical: Parallel HTTP Fetches

Fetch multiple URLs concurrently and collect all responses:

```milo
from "std/runtime" import { Promise }
from "std/fetch" import { fetch }

fn fetchBody(url: string): string {
    let resp = fetch(url)!
    return resp.text()
}

fn main(): i32 {
    var promises: Vec<Promise<string>> = Vec.new()
    promises.push(Promise((): string => { return fetchBody("http://example.com/api/users") }))
    promises.push(Promise((): string => { return fetchBody("http://example.com/api/posts") }))
    promises.push(Promise((): string => { return fetchBody("http://example.com/api/comments") }))

    let responses = Promise.all(promises).await()!
    for resp in responses {
        print(resp)
    }
    return 0
}
```

Each fetch runs on its own green task. The runtime handles non-blocking I/O transparently — the socket yields on EAGAIN and resumes when data arrives.

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

## Promise.blocking — CPU-Bound Work and Blocking FFI

The green scheduler is single-threaded and cooperative: a closure that spins on the CPU or calls a C function that blocks never yields, so it starves every other task. `Promise.blocking(fn)` runs `fn` on a real detached OS thread instead — the one escape hatch for work that can't cooperate. The result comes back through the same `await()`, so from the caller's side it is just a `Promise`. It requires explicit type args:

```milo
from "std/runtime" import { Promise }

fn crunch(): i64 { return 0 }   // heavy pure computation

fn main(): i32 {
    let p = Promise<i64>.blocking(move (): i64 => { return crunch() })
    let r = p.await()!   // the work runs on its own thread
    print(r)
    return 0
}
```

Whatever the closure captured is released before the result is sent, so by the time `await()` returns you a value, every destructor the closure owned has already run: a lock it held is free, a file it opened is closed, a reader handle it cloned is gone. That ordering is a guarantee rather than a race — a worker whose environment was torn down only after the send let a caller act on a result while the closure's resources were still alive, which is the kind of bug that shows up on one platform's scheduler and nowhere else.

The closure's captures must be `Send` (it crosses to another thread) — the compiler enforces this exactly as the old `Thread.spawn` did (see [Thread Safety](#thread-safety-send-sync)). Use `Promise.blocking` **only** for CPU-bound work or FFI that must block; ordinary I/O already yields on a plain `Promise`, so a thread would only add overhead.

Split work across cores by fanning `Promise.blocking` handles into `Promise.all` — no dedicated parallel construct needed:

```milo
from "std/runtime" import { Promise }

fn sumRange(lo: i64, hi: i64): i64 { return (lo + hi - 1) * (hi - lo) / 2 }

fn main(): i32 {
    var parts: Vec<Promise<i64>> = Vec.new()
    for k in 0..8 {
        let lo = (k as i64) * 1000
        parts.push(Promise<i64>.blocking(move (): i64 => { return sumRange(lo, lo + 1000) }))
    }
    let sums = Promise.all(parts).await()!   // 8 threads, joined through one await
    for s in sums {
        print(s)
    }
    return 0
}
```

Awaiting inside a green task is the normal case and keeps the scheduler running. Awaiting at the top level of `main` does too: whenever a program can spawn, `main` itself runs as a green task, so an await there parks it and lets every other task run. (Before that, `main` was not a task, and awaiting in it blocked the one thread the scheduler runs on.)

## Green Tasks

For fire-and-forget work that doesn't return a value, use `Task.spawn()`. Green tasks use 64KB guarded stacks (vs ~8MB for OS threads), so you can run thousands concurrently.

```milo
from "std/runtime" import { Task }

fn main(): i32 {
    let t = Task.spawn(move (): void => {
        print("hello from a task")
    })
    t.join()   // block until the task finishes
    return 0
}
```

**Exit semantics are Go's:** when `main` returns, the process exits and any tasks still running are abandoned. There is no compiler auto-drain. Waiting is always explicit — join a specific task, or use a `WaitGroup` / `Channel` / `Promise`:

```milo
from "std/runtime" import { Task }
from "std/sync" import { WaitGroup }

fn main(): i32 {
    let wg = WaitGroup.new()
    for i in 0..8 {
        wg.add(1)
        let n = i
        let w = wg.clone()       // each task needs its own owner
        Task.spawn(move (): void => {
            print(n.toString())
            w.done()
        })
    }
    wg.wait()          // returns once all 8 have called done()
    return 0
}
```

`Task.join()` must be called before the joined task can complete (i.e. right after `spawn`, before you yield or drive the scheduler) — the cooperative scheduler guarantees the registration lands first. A server that spawns an accept loop and should run forever can drive the scheduler explicitly with `schedulerRunToCompletion()` (runs every spawned task to quiescence, then tears the scheduler down):

```milo
from "std/runtime" import { Task, schedulerRunToCompletion }

fn acceptLoop(fd: i32): void {
    // accept connections and spawn a handler task per client, forever
}

fn main(): i32 {
    Task.spawn(move (): void => { acceptLoop(0) })   // never returns in a real server
    schedulerRunToCompletion()                       // main blocks here
    return 0
}
```

### Cooperative Yielding

Green tasks yield cooperatively. Use `schedulerYield()` to give other tasks a chance to run:

```milo
from "std/runtime" import { Task, schedulerYield, schedulerRunToCompletion }

fn main(): i32 {
    Task.spawn(move (): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    Task.spawn(move (): void => {
        print("B1")
        schedulerYield()
        print("B2")
    })
    schedulerRunToCompletion()
    return 0
}
// Output: A1, B1, A2, B2
```

### Transparent Async I/O

`TcpStream` operations automatically detect green task context. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

```milo
from "std/net" import { TcpStream }
from "std/runtime" import { Task, schedulerRunToCompletion }

fn handle(ip: u32, port: u16): void {
    let stream = TcpStream.connect(ip, port)!
    stream.send("hello")!          // yields if socket buffer full
    let data = stream.recv()!      // yields until data arrives
    print(data)
}

fn main(): i32 {
    Task.spawn(move (): void => { handle(0x7f000001, 8080) })   // 127.0.0.1:8080
    schedulerRunToCompletion()
    return 0
}
```

The same calls work identically on a `Promise.blocking` thread — they just block normally.

## Thread Safety (Send / Sync)

There is no Send/Sync in everyday code. Green `Task`/`Promise.run` closures stay on one thread and need nothing. `Send` is checked only where a closure starts on a real OS thread: `Promise.blocking` (and the `parallelMap` family built on it) and the low-level `spawnOsThreadDetached`. Every captured variable there must be `Send`, and a `var` global the closure writes is a compile error too (use an atomic, `Once.run`, or `thread_local var`).

**Send types** (safe to move to another thread): all primitives, `string`, `Heap<T>`, `Vec<T>`, `HashMap<K,V>`, and structs/enums where every field is Send. Ordinary types derive this structurally without annotations.

**Sync types** (safe to share via `&T` across threads): the same structural rule.

**Non-Send types**: raw pointers (`*T`) and structs containing raw pointers, unless an audited `unsafe impl` overrides the structural result.

```milo
from "std/runtime" import { Promise }

fn main(): i32 {
    // This compiles — i64 and string are Send
    let msg = "hello"
    let p = Promise<i64>.blocking(move (): i64 => {
        print(msg)
        return 0
    })
    let _ = p.await()!

    // A raw pointer is not Send — capturing one in a blocking closure is a
    // compile error: "cannot send '*u8' across threads".
    return 0
}
```

You write `unsafe impl Send` only for a struct that wraps a raw pointer, such as an FFI handle, when you can vouch for its thread safety. The std primitives (`Channel`, the atomics) already carry theirs:

```milo
struct MyHandle {
    _ptr: *u8,
}

// Safety: every access to the pointee is serialized by its mutex.
unsafe impl Send for MyHandle {}
unsafe impl Sync for MyHandle {}
```

The compiler reports which field prevents structural derivation. Manual implementations are proof obligations for the author and reviewer, so they are deliberately marked `unsafe`.
For a generic wrapper, that override covers only the wrapper representation: every instantiated type argument must still satisfy the same marker. For example, `unsafe impl Send for Wrapper<T> {}` does not make `Wrapper<*u8>` Send.

## Channels

Bounded FIFO channels for streaming values between tasks and threads. Use channels when a producer sends many values over time — for one-shot results, prefer `Promise`.

`Channel` is a handle type — safe to capture in move closures without `unsafe`.

```milo
from "std/runtime" import { Promise }
from "std/sync" import { Channel }

fn main(): i32 {
    var ch = Channel<i64>.new(8)!
    var tx = ch.clone()          // the producer needs its own owner

    let producer = Promise<i64>.blocking(move (): i64 => {
        tx.send(10)!
        tx.send(20)!
        tx.close()
        return 0
    })

    for val in ch {   // main consumes as the worker produces
        print(val)
    }
    producer.await()!
    return 0
}
```

Here the producer is a `Promise.blocking` worker so it runs while `main` consumes. Between two green tasks the same channel works with no thread — and `main` may be one end of it: because `main` runs as a green task in any program that spawns, blocking it on a channel only a green producer fills parks it and runs the producer, rather than deadlocking as it once did.

Call `close()` to signal no more values will be sent. Remaining items are delivered before iteration ends. `send()` on a closed channel returns `Result.Err`.

Non-blocking variants for polling:

```milo
from "std/sync" import { Channel }

fn main(): i32 {
    let ch = Channel<i64>.new(4)!
    ch.trySend(42)                // returns true if sent, false if full
    let val = ch.tryRecv()        // returns Option<i64> — None if empty
    match val {
        Option.Some(v) => { print(v) }
        Option.None => { print("empty") }
    }
    print(ch.len())               // current number of items
    return 0
}
```

## Sharing State Across Parallel Workers

Green tasks never run in parallel, so plain sequencing is enough between them. Only
`Promise.blocking` workers run at the same time. The ways to get data to them, best first:

| You want to | Use | What crosses the thread |
|-------------|-----|-------------------------|
| Transform a big buffer across cores | `parallelMap` ([`std/shard`](/stdlib/shard)) | disjoint owned windows, no copy |
| Return a result, or stream work out | `Channel`, `Promise` | ownership |
| Share one counter or flag | `AtomicI64` and friends ([`std/sync`](/stdlib/sync)) | one cell |

std exposes no `Mutex` for you to hold. `Channel` owns one internally (a pthread mutex and two condvars), audited once, so a producer/consumer queue costs you no lock at the call site.

### Divide the Data, Share Nothing

The usual reason to want shared state is a large `Vec` several cores should work on.
Don't share it, divide its ownership. `parallelMap` consumes the `Vec` and hands out
disjoint owned windows; each worker takes one **by move**, writes into it in place, and
gives it back. No reference crosses a thread, and nothing is copied.

```milo
from "std/shard" import { Shard, parallelMap }

fn shade(w: Shard<f64>): Shard<f64> {
    for i in 0..w.len() {
        w.set(i, w.get(i) * 2.0)
    }
    return w
}
```

`parallelMap(pixels, 4, shade)` is the whole divide/run/reassemble cycle in one call.
The buffer is moved in and comes back transformed in the same allocation. It is
infallible: every window is made, handed out, awaited and welded inside that call, so
none of your code runs in between, and the owner cannot go away under a live window.

`f` is a plain function rather than a closure because each worker needs its own copy: a
capturing closure is moved into the first worker and gone for the rest. Everything the
work depends on therefore travels in the window, which is the same thing that keeps
workers from sharing anything. Use `w.start()` when a worker needs to know which slice of
the original buffer it holds.

When the workers need their own state, or the windows should outnumber the workers,
`parallelMapWith` is the same cycle with a queue. [`std/shard`](/stdlib/shard) also has
the read-only string half (`parallelScanStr`, with overlapping windows so a scanner
never loses a match at a seam).

### Atomics

One shared cell, no mutex, for the counters and flags every worker touches.

```milo
from "std/sync" import { AtomicI64, AtomicI32, AtomicU64, AtomicBool }

fn main(): i32 {
    let counter = AtomicI64.new(0)
    counter.add(1)                  // returns the OLD value
    print(counter.load())           // 1
    counter.store(42)
    let old = counter.cas(42, 99)   // compare-and-swap, returns the old value

    let flag = AtomicBool.new(false)
    let prev = flag.swap(true)      // returns the old value
    return 0
}
```

`AtomicI64`, `AtomicI32` and `AtomicU64` carry `load`, `store`, `add`, `sub`, `swap`,
`cas`; `AtomicBool` carries all but `add`/`sub`. Every read-modify-write returns the
**old** value.

- **Every operation is `seq_cst`**, on both the success and failure path of a `cas`. There is no ordering parameter and no acquire/release/relaxed forms, so read each call as a full barrier. The cheaper orderings are a correctness cliff invisible in the source.
- **`add` and `sub` wrap** on overflow, unlike ordinary Milo arithmetic, which traps. No atomic read-modify-write has a checked form; to detect it, write a `cas` loop and inspect the old value.
- **There is no `AtomicPtr`.** It would be an `AtomicI64` plus an `unsafe` cast with nothing gained, and Milo cannot state that the pointee outlives the load. Store a `Vec` index or an arena `Handle` instead.

### Once and lazy statics

`Once` runs one initializer exactly once, however many green tasks or `Promise.blocking`
threads reach it together. The losers block until the winner finishes, so every caller
returning from `run` has seen the initializer's writes. It is correct under both worlds:
a green task parks and the scheduler keeps running, a plain OS thread waits on a condition
variable. Re-entering `run` from inside its own initializer aborts rather than hanging.

**You often need no `Once` at all.** A module-level `var` already runs a real initializer,
in dependency order, before `main`:

```milo
fn buildTable(): Vec<i64> {
    return [1, 2, 3]
}

var gTable: Vec<i64> = buildTable()   // eager, runs before main
```

Reach for `Once` when initialization must be deferred past the start of `main` (it needs
argv or a config file) or is expensive and usually unwanted. The shape is a global plus a
guard function, because a getter cannot hand back a `&T` — references are second-class:

```milo
from "std/sync" import { Once }

fn buildTable(): Vec<i64> {
    return [1, 2, 3]
}

var gTable: Vec<i64> = []
var gTableOnce: Once = Once.new()

pub fn ensureTable(): void {
    gTableOnce.run((): void => {
        gTable = buildTable()
    })
}

fn main(): i32 {
    ensureTable()
    print(gTable.len)
    return 0
}
```

Callers do `ensureTable()` and then read `gTable` directly. There is no `Lazy<T>` or
`OnceCell<T>`: with no way to return a reference, every `get()` would deep-copy the cached
value, turning a cache into a per-access allocation.

## Pitfalls

1. **`main` is a green task, in any program that can spawn one.** Every blocking std call in it parks and lets other tasks run, instead of wedging the single scheduler thread. A program with no reachable `Task.spawn` keeps the plain entry point and pays nothing for the scheduler.
2. **`main` returning abandons running tasks.** Exit semantics are Go's — wait explicitly (`join`, `WaitGroup`, `Promise`, channel, `schedulerRunToCompletion()`) or the work silently dies with the process. `exit(code)` terminates immediately from anywhere.
3. **Call `Task.join()` immediately after `spawn`.** The registration must land before the task can complete; joining after you've yielded or blocked elsewhere is a lost wakeup.
4. **The green scheduler is single-threaded and cooperative.** A task that spins on CPU or calls blocking FFI starves every other task — nothing preempts it. Move that work to `Promise.blocking`; long compute loops that must stay on a task should `schedulerYield()` periodically.
5. **OS threads start only in `Promise.blocking`** (which `parallelMap` uses per worker) and the low-level `spawnOsThreadDetached`. Those closures run in parallel and their captures must be `Send`; a plain `Promise`/`Task` closure stays on the scheduler and has no such requirement. Use `blocking` only for CPU-bound work or blocking FFI, since ordinary I/O already yields on a green task.
6. **Channels, `WaitGroup`, atomics, and `Once` are reference-counted handles.** `.clone()` to give another task or worker its own owner; the shared object frees itself when the last owner drops. There is no `.destroy()`.
7. **Channels must be `close()`d** or the consumer's `for val in ch` never ends. `send` on a closed channel returns `Result.Err`, not a panic. Bounded `send` blocking when full is backpressure, not a bug — poll with `trySend`/`tryRecv`.
8. **Move closures capture copies.** Mutating a captured `var` inside a task or worker is invisible outside. Communicate results through a `Channel`/`Promise`, or share through an atomic — never through captured locals.

## Concurrency API

| Function | Description |
|----------|-------------|
| `Task.spawn(move () => {...})` | Spawn a green task |
| `t.join()` | Wait for a task to finish |
| `Promise(fn)` / `Promise<T>.run(fn)` | Run `fn` on a green task, result via `await` |
| `Promise<T>.blocking(fn)` | Run `fn` on an OS thread (CPU-bound / blocking FFI) |
| `p.await()` | Wait for a promise's result |
| `Promise.all(v)` / `Promise.race(v)` | Collect all results / first to finish |
| `parallelMap(v, n, f)` | Divide a `Vec` across `n` OS threads, transform in place, reassemble (`std/shard`) |
| `parallelMapWith(v, windows, states, f)` | The same cycle with per-worker state and a window queue |
| `parallelScanStr(s, n, overlap, f)` | Divide a `string` into read-only windows and scan on `n` threads |
| `Channel.new(cap)` | Create bounded channel |
| `ch.send(val)` | Send value (blocks if full) |
| `ch.recv()` | Receive value (blocks if empty) |
| `ch.trySend(val)` | Non-blocking send, returns `bool` |
| `ch.tryRecv()` | Non-blocking receive, returns `Option<T>` |
| `ch.close()` | Signal no more values |
| `ch.len()` | Current items in channel |
| `WaitGroup.new()` | Create a wait group |
| `wg.add(n)` / `wg.done()` / `wg.wait()` | Track and await a fleet of tasks |
| `AtomicI64.new(v)` / `AtomicI32.new(v)` / `AtomicU64.new(v)` / `AtomicBool.new(v)` | Create atomic |
| `a.load()` | Atomic read |
| `a.store(v)` | Atomic write |
| `a.add(v)` / `a.sub(v)` | Atomic add/sub, wrapping (returns old) |
| `a.cas(exp, des)` | Compare-and-swap (returns old) |
| `a.swap(v)` | Atomic swap (returns old) |
| `Once.new()` | Create a run-exactly-once guard |
| `o.run(fn)` | Run `fn` once; later callers block until it finishes |
| `o.isDone()` | True once the initializer has completed |
| `x.clone()` | Give another task/worker its own owner of a channel, wait group, atomic, or `Once` |
