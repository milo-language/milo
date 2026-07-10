# std/sync

Channel, wait-group, and atomic primitives for coordinating green tasks and `Promise.blocking` workers.

```milo
from "std/sync" import { Channel, WaitGroup, AtomicI64, AtomicBool }
```

There is no `Mutex` or `RwLock`: green tasks never run in parallel, and parallel `Promise.blocking` workers share state through channels (pass ownership) or atomics (lock-free counters and flags). See [Concurrency](/language/concurrency).

## Types

### Channel

```milo
struct Channel {
    _ptr: *u8,
}
```

Bounded FIFO channel for streaming values between green tasks and `Promise.blocking` workers. Blocks on send when full, blocks on recv when empty.

### WaitGroup

```milo
struct WaitGroup {
    _ptr: *u8,
}
```

Counting barrier — `add` before spawning, `done` from each task, `wait` for the counter to reach zero.

### AtomicI64

```milo
struct AtomicI64 {
    _ptr: *u8,
}
```

Lock-free 64-bit atomic integer. All operations use sequential consistency.

### AtomicBool

```milo
struct AtomicBool {
    _ptr: *u8,
}
```

Lock-free atomic boolean. All operations use sequential consistency.

## Channel Methods

### Channel.new

```milo
fn Channel.new(capacity: i64): Result<Channel>
```

Create a bounded channel with the given capacity.

### ch.send

```milo
fn send(self: &Channel, val: i64): Result<i32>
```

Send a value into the channel. Blocks if full.

### ch.recv

```milo
fn recv(self: &Channel): Result<i64>
```

Receive a value from the channel. Blocks if empty.

### ch.trySend

```milo
fn trySend(self: &Channel, val: i64): bool
```

Non-blocking send. Returns true if sent, false if full.

### ch.tryRecv

```milo
fn tryRecv(self: &Channel): Option<i64>
```

Non-blocking receive. Returns `Option.None` if empty.

### ch.len

```milo
fn len(self: &Channel): i64
```

Current number of items in the channel.

### ch.destroy

```milo
fn destroy(self: &Channel): void
```

Free the underlying channel resource.

## WaitGroup Methods

### WaitGroup.new

```milo
fn WaitGroup.new(): WaitGroup
```

Create a new wait group with a zero counter.

### wg.add

```milo
fn add(self: &WaitGroup, n: i64): void
```

Add `n` to the counter — call before spawning the tasks it tracks.

### wg.done

```milo
fn done(self: &WaitGroup): void
```

Decrement the counter by one — call from each task when it finishes.

### wg.wait

```milo
fn wait(self: &WaitGroup): void
```

Block until the counter reaches zero.

### wg.destroy

```milo
fn destroy(self: &WaitGroup): void
```

Free the underlying wait-group resource.

## AtomicI64 Methods

### AtomicI64.new

```milo
fn AtomicI64.new(v: i64): AtomicI64
```

Create an atomic integer with initial value.

### a.load

```milo
fn load(self: &AtomicI64): i64
```

Atomic read.

### a.store

```milo
fn store(self: &AtomicI64, v: i64): void
```

Atomic write.

### a.add

```milo
fn add(self: &AtomicI64, v: i64): i64
```

Atomic add. Returns old value.

### a.sub

```milo
fn sub(self: &AtomicI64, v: i64): i64
```

Atomic subtract. Returns old value.

### a.cas

```milo
fn cas(self: &AtomicI64, expected: i64, desired: i64): i64
```

Compare-and-swap. Returns old value.

### a.destroy

```milo
fn destroy(self: &AtomicI64): void
```

Free the atomic resource.

## AtomicBool Methods

### AtomicBool.new

```milo
fn AtomicBool.new(v: bool): AtomicBool
```

Create an atomic boolean with initial value.

### a.load

```milo
fn load(self: &AtomicBool): bool
```

Atomic read.

### a.store

```milo
fn store(self: &AtomicBool, v: bool): void
```

Atomic write.

### a.swap

```milo
fn swap(self: &AtomicBool, v: bool): bool
```

Atomic swap. Returns old value.

### a.destroy

```milo
fn destroy(self: &AtomicBool): void
```

Free the atomic resource.

## Example: Producer-Consumer

The producer runs on a `Promise.blocking` worker so it makes progress while `main` consumes on the channel (a green producer would only run while the scheduler is driven):

```milo
from "std/runtime" import { Promise }
from "std/sync" import { Channel }

fn main(): i32 {
    var ch = Channel<i64>.new(8)!

    let producer = Promise<i64>.blocking(move (): i64 => {
        ch.send(10)!
        ch.send(20)!
        ch.send(30)!
        ch.close()
        return 0
    })

    for val in ch {
        print(val)
    }

    producer.await()!
    ch.destroy()
    print("done")
    return 0
}
```
