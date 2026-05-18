# std/sync

Mutex, channel, rwlock, and atomic primitives for thread synchronization.

```milo
from "std/sync" import { Mutex, Channel, RwLock, AtomicI64, AtomicBool }
```

## Types

### Mutex

```milo
struct Mutex {
    _handle: *u8,
}
```

OS-level mutex. Must be destroyed after use to avoid resource leaks.

### Channel

```milo
struct Channel {
    _ptr: *u8,
}
```

Bounded FIFO channel for sending `i64` values between threads. Blocks on send when full, blocks on recv when empty.

### RwLock

```milo
struct RwLock {
    _handle: *u8,
}
```

Reader-writer lock: multiple concurrent readers OR one exclusive writer.

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

## Mutex Methods

### Mutex.new

```milo
fn Mutex.new(): Result<Mutex>
```

Create a new unlocked mutex.

### m.lock

```milo
fn lock(self: &Mutex): Result<i32>
```

Acquire the lock. Blocks if another thread holds it.

### m.unlock

```milo
fn unlock(self: &Mutex): Result<i32>
```

Release the lock.

### m.withLock

```milo
fn withLock(self: &Mutex, f: () => void): Result<i32>
```

Scoped locking — acquires, runs closure, unlocks. Guarantees unlock.

### m.destroy

```milo
fn destroy(self: &Mutex): void
```

Free the underlying OS mutex resource.

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

## RwLock Methods

### RwLock.new

```milo
fn RwLock.new(): Result<RwLock>
```

Create a new reader-writer lock.

### r.read

```milo
fn read(self: &RwLock): Result<i32>
```

Acquire a read lock. Multiple readers allowed simultaneously.

### r.write

```milo
fn write(self: &RwLock): Result<i32>
```

Acquire an exclusive write lock.

### r.unlock

```milo
fn unlock(self: &RwLock): Result<i32>
```

Release the lock.

### r.withReadLock

```milo
fn withReadLock(self: &RwLock, f: () => void): Result<i32>
```

Scoped read lock — acquires, runs closure, unlocks.

### r.withWriteLock

```milo
fn withWriteLock(self: &RwLock, f: () => void): Result<i32>
```

Scoped write lock — acquires, runs closure, unlocks.

### r.destroy

```milo
fn destroy(self: &RwLock): void
```

Free the underlying rwlock resource.

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

```milo
from "std/thread" import { Thread }
from "std/sync" import { Channel }

fn main(): i32 {
    let ch = Channel.new(8)!

    let t = Thread.spawn(move (): void => {
        ch.send(10)!
        ch.send(20)!
        ch.send(30)!
        ch.send(0)!
    })!

    while true {
        let val = ch.recv()!
        if val == 0 {
            break
        }
        print(val)
    }

    t.join()!
    ch.destroy()
    print("done")
    return 0
}
```
