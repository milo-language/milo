# std/sync

## std/sync

### `AtomicBool.cas`

```milo
fn AtomicBool.cas(self: &AtomicBool, expected: bool, desired: bool): bool
```

Returns the value that was there — equal to `expected` exactly when the swap
happened, which is how a caller claims a one-shot flag: `f.cas(false, true) == false`.

### `AtomicBool.clone`

```milo
fn AtomicBool.clone(self: &AtomicBool): AtomicBool
```

Share this atomic with another owner; freed when the last owner drops.

### `AtomicBool.load`

```milo
fn AtomicBool.load(self: &AtomicBool): bool
```

_Undocumented._

### `AtomicBool.new`

```milo
fn AtomicBool.new(initial: bool): AtomicBool
```

_Undocumented._

### `AtomicBool.store`

```milo
fn AtomicBool.store(self: &AtomicBool, val: bool): void
```

_Undocumented._

### `AtomicBool.swap`

```milo
fn AtomicBool.swap(self: &AtomicBool, val: bool): bool
```

_Undocumented._

### `AtomicI32.add`

```milo
fn AtomicI32.add(self: &AtomicI32, val: i32): i32
```

Returns the OLD value. Wraps on overflow.

### `AtomicI32.cas`

```milo
fn AtomicI32.cas(self: &AtomicI32, expected: i32, desired: i32): i32
```

Store `desired` only if the current value is `expected`. Returns the value that
was there — equal to `expected` exactly when the swap happened.

### `AtomicI32.clone`

```milo
fn AtomicI32.clone(self: &AtomicI32): AtomicI32
```

Share this atomic with another owner; freed when the last owner drops.

### `AtomicI32.load`

```milo
fn AtomicI32.load(self: &AtomicI32): i32
```

_Undocumented._

### `AtomicI32.new`

```milo
fn AtomicI32.new(initial: i32): AtomicI32
```

_Undocumented._

### `AtomicI32.store`

```milo
fn AtomicI32.store(self: &AtomicI32, val: i32): void
```

_Undocumented._

### `AtomicI32.sub`

```milo
fn AtomicI32.sub(self: &AtomicI32, val: i32): i32
```

Returns the OLD value. Wraps on underflow.

### `AtomicI32.swap`

```milo
fn AtomicI32.swap(self: &AtomicI32, val: i32): i32
```

_Undocumented._

### `AtomicI64.add`

```milo
fn AtomicI64.add(self: &AtomicI64, val: i64): i64
```

_Undocumented._

### `AtomicI64.cas`

```milo
fn AtomicI64.cas(self: &AtomicI64, expected: i64, desired: i64): i64
```

Store `desired` only if the current value is `expected`. Returns the value that
was there — equal to `expected` exactly when the swap happened.

### `AtomicI64.clone`

```milo
fn AtomicI64.clone(self: &AtomicI64): AtomicI64
```

Share this atomic with another owner (e.g. a spawned task). Each clone must be
dropped exactly once; the underlying storage is freed when the last owner drops.

### `AtomicI64.load`

```milo
fn AtomicI64.load(self: &AtomicI64): i64
```

_Undocumented._

### `AtomicI64.new`

```milo
fn AtomicI64.new(initial: i64): AtomicI64
```

_Undocumented._

### `AtomicI64.store`

```milo
fn AtomicI64.store(self: &AtomicI64, val: i64): void
```

_Undocumented._

### `AtomicI64.sub`

```milo
fn AtomicI64.sub(self: &AtomicI64, val: i64): i64
```

_Undocumented._

### `AtomicI64.swap`

```milo
fn AtomicI64.swap(self: &AtomicI64, val: i64): i64
```

_Undocumented._

### `AtomicU64.add`

```milo
fn AtomicU64.add(self: &AtomicU64, val: u64): u64
```

Returns the OLD value. Wraps on overflow.

### `AtomicU64.cas`

```milo
fn AtomicU64.cas(self: &AtomicU64, expected: u64, desired: u64): u64
```

Store `desired` only if the current value is `expected`. Returns the value that
was there — equal to `expected` exactly when the swap happened.

### `AtomicU64.clone`

```milo
fn AtomicU64.clone(self: &AtomicU64): AtomicU64
```

Share this atomic with another owner; freed when the last owner drops.

### `AtomicU64.load`

```milo
fn AtomicU64.load(self: &AtomicU64): u64
```

_Undocumented._

### `AtomicU64.new`

```milo
fn AtomicU64.new(initial: u64): AtomicU64
```

_Undocumented._

### `AtomicU64.store`

```milo
fn AtomicU64.store(self: &AtomicU64, val: u64): void
```

_Undocumented._

### `AtomicU64.sub`

```milo
fn AtomicU64.sub(self: &AtomicU64, val: u64): u64
```

Returns the OLD value. Wraps on underflow.

### `AtomicU64.swap`

```milo
fn AtomicU64.swap(self: &AtomicU64, val: u64): u64
```

_Undocumented._

### `Channel.clone`

```milo
fn Channel.clone(self: &Channel): Channel<T>
```

Share this channel with another owner (a spawned producer/consumer). Each clone
must be dropped exactly once; the queue is torn down when the last owner drops,
and any payload still queued at that point is destroyed (its `Drop` runs once).
Values already received are the receiver's and are not touched.
send/recv take &Self, so a handle only needs cloning when moved into a task while
the parent still uses it.

### `Channel.close`

```milo
fn Channel.close(self: &Channel): void
```

Signal no more values will be sent. Pending items are still delivered.

### `Channel.len`

```milo
fn Channel.len(self: &Channel): i64
```

_Undocumented._

### `Channel.new`

```milo
fn Channel.new(capacity: i64): Result<Channel<T>>
```

_Undocumented._

### `Channel.next`

```milo
fn Channel.next(self: &mut Channel): Option<T>
```

Iterator protocol — enables `for val in channel { ... }`
Uses match, not let-else: std must stay within the subset milo-self parses
(src-milo has no let-else yet), or self-host can't compile std.

### `Channel.rawPtr`

```milo
fn Channel.rawPtr(self: &Channel): *u8
```

Raw ChannelInner pointer, for std/select arm hooks (channelArm*).

### `Channel.recv`

```milo
fn Channel.recv(self: &Channel): Result<T>
```

_Undocumented._

### `Channel.send`

```milo
fn Channel.send(self: &Channel, val: T): Result<i32>
```

_Undocumented._

### `Channel.tryRecv`

```milo
fn Channel.tryRecv(self: &Channel): Option<T>
```

_Undocumented._

### `Channel.trySend`

```milo
fn Channel.trySend(self: &Channel, val: T): bool
```

_Undocumented._

### `ChannelHandle.retain`

```milo
fn ChannelHandle.retain(self: &ChannelHandle): ChannelHandle
```

_Undocumented._

### `Once.clone`

```milo
fn Once.clone(self: &Once): Once
```

Share this Once with another owner (a worker task/thread); freed when the last
owner drops. `run` takes &Self, so a module-level Once never needs a clone.

### `Once.isDone`

```milo
fn Once.isDone(self: &Once): bool
```

True once the initializer has completed. Still false while it is running, so
this is a progress hint, never a substitute for `run`.

### `Once.new`

```milo
fn Once.new(): Once
```

_Undocumented._

### `Once.run`

```milo
fn Once.run(self: &Once, f: () => void): void
```

Run `f` if nobody has yet, otherwise block until whoever did is finished.
Returns only once the initializer has completed exactly once, process-wide.
@synchronized: `f` is a critical section. The embedded mutex serializes it and the
atomic state word publishes its writes, so globals mutated in here are not racing.

### `WaitGroup.add`

```milo
fn WaitGroup.add(self: &WaitGroup, n: i64): void
```

_Undocumented._

### `WaitGroup.clone`

```milo
fn WaitGroup.clone(self: &WaitGroup): WaitGroup
```

Share this WaitGroup with another owner (e.g. a worker task); freed when the
last owner drops. add/done/wait take &Self, so most uses need no clone.

### `WaitGroup.done`

```milo
fn WaitGroup.done(self: &WaitGroup): void
```

_Undocumented._

### `WaitGroup.new`

```milo
fn WaitGroup.new(): WaitGroup
```

_Undocumented._

### `WaitGroup.wait`

```milo
fn WaitGroup.wait(self: &WaitGroup): void
```

_Undocumented._
