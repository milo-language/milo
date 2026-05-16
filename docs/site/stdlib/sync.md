# std/sync

Mutex and channel primitives for thread synchronization.

```milo
from "std/sync" import { Mutex, mutexNew, mutexLock, mutexUnlock, mutexDestroy, Channel, channelNew, channelSend, channelRecv, channelDestroy }
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

## Mutex Functions

### mutexNew

```milo
fn mutexNew(): Result<Mutex>
```

Create a new unlocked mutex.

### mutexLock

```milo
fn mutexLock(m: &Mutex): Result<i32>
```

Acquire the lock. Blocks if another thread holds it.

### mutexUnlock

```milo
fn mutexUnlock(m: &Mutex): Result<i32>
```

Release the lock.

### mutexDestroy

```milo
fn mutexDestroy(m: &Mutex): void
```

Free the underlying OS mutex resource.

## Channel Functions

### channelNew

```milo
fn channelNew(capacity: i64): Result<Channel>
```

Create a bounded channel with the given capacity.

### channelSend

```milo
fn channelSend(ch: &Channel, val: i64): Result<i32>
```

Send a value into the channel. Blocks if full.

### channelRecv

```milo
fn channelRecv(ch: &Channel): Result<i64>
```

Receive a value from the channel. Blocks if empty.

### channelDestroy

```milo
fn channelDestroy(ch: &Channel): void
```

Free the underlying channel resource.

## Example: Producer-Consumer

```milo
from "std/thread" import { spawn, threadJoin }
from "std/sync" import { channelNew, channelSend, channelRecv, channelDestroy }

fn main(): i32 {
    let ch = channelNew(8)!

    let t = spawn(move (): void => {
        channelSend(ch, 10)!
        channelSend(ch, 20)!
        channelSend(ch, 30)!
        channelSend(ch, 0)!
    })!

    while true {
        let val = channelRecv(ch)!
        if val == 0 {
            break
        }
        print(val)
    }

    threadJoin(t)!
    channelDestroy(ch)
    print("done")
    return 0
}
```
