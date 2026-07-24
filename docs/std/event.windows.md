# std/event.windows

## std/event.windows

### `clearNonblocking`

```milo
pub fn clearNonblocking(fd: i32): i32
```

Restore blocking mode; same socket-only caveat as setNonblocking.

### `eventDeregister`

```milo
pub fn eventDeregister(el: &EventLoop, fd: i32, forWrite: bool): i32
```

_Undocumented._

### `eventLoopClose`

```milo
pub fn eventLoopClose(el: &EventLoop): void
```

_Undocumented._

### `eventLoopCloseWakeup`

```milo
pub fn eventLoopCloseWakeup(el: &EventLoop, _wakeupId: i32): void
```

_Undocumented._

### `eventLoopDrainWakeup`

```milo
pub fn eventLoopDrainWakeup(_el: &EventLoop, _wakeupId: i32): void
```

_Undocumented._

### `eventLoopFd`

```milo
pub fn eventLoopFd(el: &EventLoop): i32
```

_Undocumented._

### `eventLoopFromFd`

```milo
pub fn eventLoopFromFd(slot: i32): EventLoop
```

_Undocumented._

### `eventLoopInitWakeup`

```milo
pub fn eventLoopInitWakeup(el: &EventLoop): i32
```

Auto-reset Event, initially non-signaled. Auto-reset means a single wait consumes the
signal and there is nothing to drain; multiple notifies before a wait coalesce into one
wakeup, which is exactly right — a wakeup only means "re-check runnable state".

### `eventLoopNew`

```milo
pub fn eventLoopNew(): Result<EventLoop, string>
```

_Undocumented._

### `eventLoopNotify`

```milo
pub fn eventLoopNotify(el: &EventLoop, _wakeupId: i32): i32
```

safe from any thread: SetEvent is thread-safe, and the slot's wakeup handle was written at
init before this loop was reachable cross-thread.

### `eventPoll`

```milo
pub fn eventPoll(el: &EventLoop, readyFds: *i32, _maxEvents: i32, timeoutMs: i32): i32
```

poll the loop once. Waits up to timeoutMs (negative = block indefinitely) on the wakeup
Event and every registered socket's WSAEVENT together. On wake, reports the wakeup (if it
fired) plus every socket with a pending network event, as a flat fd list.

### `eventRegisterRead`

```milo
pub fn eventRegisterRead(el: &EventLoop, fd: i32): i32
```

_Undocumented._

### `eventRegisterWrite`

```milo
pub fn eventRegisterWrite(el: &EventLoop, fd: i32): i32
```

_Undocumented._

### `fionbio`

```milo
pub fn fionbio(): i32
```

FIONBIO = 0x8004667E as a signed 32-bit value.

### `maskRead`

```milo
pub fn maskRead(): i32
```

_Undocumented._

### `maskToNet`

```milo
pub fn maskToNet(mask: i32): i32
```

_Undocumented._

### `maskWrite`

```milo
pub fn maskWrite(): i32
```

_Undocumented._

### `setNonblocking`

```milo
pub fn setNonblocking(fd: i32): i32
```

_Undocumented._

### `wakeupIdentBase`

```milo
pub fn wakeupIdentBase(): i32
```

ident chosen far above any real fd so eventPoll consumers can tell a wakeup apart from fd
readiness in the same readyFds array (matches the darwin/linux convention).

### `winLoopAt`

```milo
fn winLoopAt(slot: i32): *u8
```

_Undocumented._

### `winLoopTableCap`

```milo
pub fn winLoopTableCap(): i32
```

16 concurrent scheduler loops is far beyond any real program.

### `winLoopTableInit`

```milo
fn winLoopTableInit(): void
```

_Undocumented._

### `wlCap`

```milo
pub fn wlCap(): i64
```

_Undocumented._

### `wlFind`

```milo
fn wlFind(st: *u8, fd: i32): i64
```

Find fd in the interest set, or -1.

### `wlGet`

```milo
pub fn wlGet(b: *u8, idx: i64): i64
```

_Undocumented._

### `wlMaskIdx`

```milo
pub fn wlMaskIdx(i: i64): i64
```

_Undocumented._

### `wlRegister`

```milo
fn wlRegister(st: *u8, fd: i32, bit: i32): i32
```

Add the given interest bit to fd, creating its WSAEVENT on first registration, and (re)arm
WSAEventSelect with the combined mask.

### `wlSet`

```milo
pub fn wlSet(b: *u8, idx: i64, v: i64): void
```

_Undocumented._

### `wlSize`

```milo
pub fn wlSize(): i64
```

_Undocumented._

### `wlSockIdx`

```milo
pub fn wlSockIdx(i: i64): i64
```

_Undocumented._

### `wlWevtIdx`

```milo
pub fn wlWevtIdx(i: i64): i64
```

_Undocumented._
