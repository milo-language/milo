# std/sync

## std/sync

### `AtomicBool.destroy`

```milo
fn AtomicBool.destroy(self: AtomicBool): void
```

_Undocumented._

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

### `AtomicI64.add`

```milo
fn AtomicI64.add(self: &AtomicI64, val: i64): i64
```

_Undocumented._

### `AtomicI64.cas`

```milo
fn AtomicI64.cas(self: &AtomicI64, expected: i64, desired: i64): i64
```

_Undocumented._

### `AtomicI64.destroy`

```milo
fn AtomicI64.destroy(self: AtomicI64): void
```

_Undocumented._

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

### `Channel.close`

```milo
fn Channel.close(self: &Channel): void
```

Signal no more values will be sent. Pending items are still delivered.

### `Channel.destroy`

```milo
fn Channel.destroy(self: &Channel): void
```

_Undocumented._

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

### `channelArmRecv`

```milo
pub fn channelArmRecv(ptr: *u8, node: *u8): bool
```

Arm a Select recv on this channel. Returns true if recv would proceed right
now (buffer non-empty or closed) — the caller claims immediately and does not
link. Otherwise links `node` (kind sel-recv) and returns false.

### `channelArmSend`

```milo
pub fn channelArmSend(ptr: *u8, node: *u8): bool
```

Arm a Select send. Ready if the buffer has room or the channel is closed
(a send on a closed channel returns Err rather than blocking).

### `channelUnarmRecv`

```milo
pub fn channelUnarmRecv(ptr: *u8, node: *u8): void
```

_Undocumented._

### `channelUnarmSend`

```milo
pub fn channelUnarmSend(ptr: *u8, node: *u8): void
```

_Undocumented._

### `chParkRecv`

```milo
fn chParkRecv(inner: *ChannelInner): void
```

Park the current green task as a receive waiter. Caller holds mtx; returns
with mtx re-acquired. The waiter node lives on this frame's stack — safe
because the frame stays alive while parked and the waker pops the node
(under mtx) before unparking, so it never dangles.

### `chParkSend`

```milo
fn chParkSend(inner: *ChannelInner): void
```

_Undocumented._

### `chWakeOneRecv`

```milo
fn chWakeOneRecv(inner: *ChannelInner): void
```

_Undocumented._

### `chWakeOneSend`

```milo
fn chWakeOneSend(inner: *ChannelInner): void
```

_Undocumented._

### `nodeLoadI64`

```milo
fn nodeLoadI64(node: *u8, off: i64): i64
```

_Undocumented._

### `nodeLoadPtr`

```milo
fn nodeLoadPtr(node: *u8, off: i64): *u8
```

Waiter nodes use the unified 48-byte runtime layout (see std/runtime): plain
channel waiters are kind 0 with the task ptr at nodeA; Select arms (kind 1/2)
carry a SelectState ptr + arm index and take the claim path when woken.

### `nodeStoreI64`

```milo
fn nodeStoreI64(node: *u8, off: i64, v: i64): void
```

_Undocumented._

### `nodeStorePtr`

```milo
fn nodeStorePtr(node: *u8, off: i64, v: *u8): void
```

_Undocumented._

### `unlinkNode`

```milo
fn unlinkNode(head: *u8, node: *u8): *u8
```

Unlink `node` from a wait list if present. Caller holds the channel mutex.

### `WaitGroup.add`

```milo
fn WaitGroup.add(self: &WaitGroup, n: i64): void
```

_Undocumented._

### `WaitGroup.destroy`

```milo
fn WaitGroup.destroy(self: WaitGroup): void
```

_Undocumented._

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

### `wakeOne`

```milo
fn wakeOne(head: *u8): *u8
```

Pop one waiter off `head` (a channel wait list) and wake it. Caller holds the
channel mutex. A plain waiter's task is unparked; a Select arm claims the
select. Returns the new head. The node must not be touched after this — the
woken task's frame (plain) or the Select (arm) owns it.
