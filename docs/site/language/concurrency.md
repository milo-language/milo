# Concurrency

Milo has **one** concurrency model: **green tasks** on a cooperative, single-threaded scheduler, with a **single OS-thread escape hatch** (`Promise.blocking`). There is no `async`/`await` and no function coloring — you write blocking code, and the runtime runs it concurrently.

`Task.spawn` runs a closure on the green scheduler; `Promise<T>`, `Channel`, `select`, and `WaitGroup` all park the *task*, not the OS thread, so they compose freely. Blocking I/O and channel operations yield to other tasks automatically — there is no event loop to run by hand. The one way onto a real OS thread is [`Promise.blocking`](#promise-blocking-cpu-bound-work-and-blocking-ffi), for CPU-bound parallelism and blocking FFI.

For most concurrent work, reach for `Promise<T>`.

## Which to Use

| Need | Use |
|------|-----|
| One-shot result off the main flow | `Promise(fn)` → `.await()!`; fan-out with `Promise.all`, first-wins with `Promise.race` |
| Stream of values over time | `Channel<T>` — producer `send`s + `close()`s, consumer `for val in ch` |
| Fleet of fire-and-forget workers | `Task.spawn` + `WaitGroup` |
| Wait on first-of-many sources | `std/select` |
| CPU-bound work or blocking FFI | `Promise.blocking(fn)` → `.await()!`; fan out across cores via `Promise.all` |
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
from "std/net" import { fetch }

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

**Caveat:** awaiting inside a green task is the normal case and keeps the scheduler running. Awaiting a `Promise.blocking` at the top level of `main` parks the main thread on the worker and does **not** simultaneously drive other green tasks — await from within a task (or call `schedulerRunToCompletion()`) if you need concurrency during the wait.

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
        Task.spawn(move (): void => {
            print(n.toString())
            wg.done()
        })
    }
    wg.wait()          // returns once all 8 have called done()
    wg.destroy()
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
from "std/runtime" import { Task, schedulerYield }

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

The compiler enforces thread safety at compile time. Because `Promise.blocking` runs its closure on a real OS thread, it requires every captured variable to implement `Send` — safe to transfer across threads. (Green `Task`/`Promise.run` closures stay on one thread and carry no such requirement.)

**Send types** (safe to move to another thread): all primitives, `string`, `Heap<T>`, `Vec<T>`, `HashMap<K,V>`, structs/enums where all fields are Send, and any struct annotated with `@send`.

**Sync types** (safe to share via `&T` across threads): same rules, checked via `@sync`.

**Non-Send types**: raw pointers (`*T`), structs containing raw pointers (unless annotated).

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

Use `@send` and `@sync` annotations to mark types with unsafe internals as thread-safe:

```milo
@send
@sync
struct MyHandle {
    _ptr: *u8,   // raw pointer, but we guarantee thread safety
}
```

The compiler error message tells you exactly which field breaks Send and suggests adding the annotation. This prevents data races at compile time — if you can't send a raw pointer to another thread, you can't have unsynchronized shared mutable state.

## Channels

Bounded FIFO channels for streaming values between tasks and threads. Use channels when a producer sends many values over time — for one-shot results, prefer `Promise`.

`Channel` is a handle type — safe to capture in move closures without `unsafe`.

```milo
from "std/runtime" import { Promise }
from "std/sync" import { Channel }

fn main(): i32 {
    var ch = Channel<i64>.new(8)!

    let producer = Promise<i64>.blocking(move (): i64 => {
        ch.send(10)!
        ch.send(20)!
        ch.close()
        return 0
    })

    for val in ch {   // main consumes as the worker produces
        print(val)
    }
    producer.await()!
    ch.destroy()
    return 0
}
```

Here the producer is a `Promise.blocking` worker so it runs while `main` consumes. Between two green tasks the same channel works with no thread — but a green producer only runs when the scheduler is driven, so **don't block `main` on a channel that only a green task fills** (await inside a task, or drive with `schedulerRunToCompletion`).

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
    ch.destroy()
    return 0
}
```

## Sharing State Across Parallel Workers

Green tasks never run in parallel, so plain sequencing protects task-to-task state. Across `Promise.blocking` workers, which *do* run in parallel, share through **channels** (pass ownership) or **atomics** (lock-free counters and flags) rather than a lock. Move-capture gives each worker its own copy of what it captures, so a fan-out that returns results through `await` needs no synchronization at all.

### Atomics

Lock-free atomic types for cross-thread counters and flags. No mutex needed.

```milo
from "std/sync" import { AtomicI64, AtomicBool }

fn main(): i32 {
    let counter = AtomicI64.new(0)
    counter.add(1)                  // returns old value
    print(counter.load())           // 1
    counter.store(42)
    let old = counter.cas(42, 99)   // compare-and-swap, returns old value
    counter.destroy()

    let flag = AtomicBool.new(false)
    flag.store(true)
    let prev = flag.swap(false)     // returns old value
    flag.destroy()
    return 0
}
```

All atomic operations use sequential consistency (seq_cst). `AtomicI64` and `AtomicBool` are `@send` + `@sync` — safe to share across threads.

## Pitfalls

1. **`main` returning abandons running tasks.** Exit semantics are Go's — wait explicitly (`join`, `WaitGroup`, `Promise`, channel, `schedulerRunToCompletion()`) or the work silently dies with the process. `exit(code)` terminates immediately from anywhere.
2. **Call `Task.join()` immediately after `spawn`.** The registration must land before the task can complete; joining after you've yielded or blocked elsewhere is a lost wakeup.
3. **The green scheduler is single-threaded and cooperative.** A task that spins on CPU or calls blocking FFI starves every other task — nothing preempts it. Move that work to `Promise.blocking`; long compute loops that must stay on a task should `schedulerYield()` periodically.
4. **`Promise.blocking` is the only OS thread.** Its closure runs in parallel and its captures must be `Send`; a plain `Promise`/`Task` closure stays on the scheduler and has no such requirement. Use `blocking` only for CPU-bound work or blocking FFI — ordinary I/O already yields on a green task.
5. **Channels, `WaitGroup`, and atomics are shared handles with manual lifecycle.** Copying one shares the underlying object, so there is no automatic drop — call `.destroy()` exactly once, after every user is done. (`Promise` is the exception: `await` frees it for you.)
6. **Channels must be `close()`d** or the consumer's `for val in ch` never ends. `send` on a closed channel returns `Result.Err`, not a panic. Bounded `send` blocking when full is backpressure, not a bug — poll with `trySend`/`tryRecv`.
7. **Move closures capture copies.** Mutating a captured `var` inside a task or worker is invisible outside. Communicate results through a `Channel`/`Promise`, or share through an atomic — never through captured locals.

## Concurrency API

| Function | Description |
|----------|-------------|
| `Task.spawn(move () => {...})` | Spawn a green task |
| `t.join()` | Wait for a task to finish |
| `Promise(fn)` / `Promise<T>.run(fn)` | Run `fn` on a green task, result via `await` |
| `Promise<T>.blocking(fn)` | Run `fn` on an OS thread (CPU-bound / blocking FFI) |
| `p.await()` | Wait for a promise's result |
| `Promise.all(v)` / `Promise.race(v)` | Collect all results / first to finish |
| `Channel.new(cap)` | Create bounded channel |
| `ch.send(val)` | Send value (blocks if full) |
| `ch.recv()` | Receive value (blocks if empty) |
| `ch.trySend(val)` | Non-blocking send, returns `bool` |
| `ch.tryRecv()` | Non-blocking receive, returns `Option<T>` |
| `ch.close()` | Signal no more values |
| `ch.len()` | Current items in channel |
| `ch.destroy()` | Free channel resources |
| `WaitGroup.new()` | Create a wait group |
| `wg.add(n)` / `wg.done()` / `wg.wait()` | Track and await a fleet of tasks |
| `AtomicI64.new(v)` / `AtomicBool.new(v)` | Create atomic |
| `a.load()` | Atomic read |
| `a.store(v)` | Atomic write |
| `a.add(v)` / `a.sub(v)` | Atomic add/sub (returns old) |
| `a.cas(exp, des)` | Compare-and-swap (returns old) |
| `a.swap(v)` | Atomic swap (returns old) |
| `a.destroy()` | Free atomic |
