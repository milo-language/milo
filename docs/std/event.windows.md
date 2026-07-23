# std/event.windows

## std/event.windows

### `clearNonblocking`

```milo
fn clearNonblocking(fd: i32): i32
```

Restore blocking mode; same socket-only caveat as setNonblocking.

### `eventDeregister`

```milo
fn eventDeregister(el: &EventLoop, fd: i32, forWrite: bool): i32
```

_Undocumented._

### `eventLoopClose`

```milo
fn eventLoopClose(el: &EventLoop): void
```

_Undocumented._

### `eventLoopCloseWakeup`

```milo
fn eventLoopCloseWakeup(el: &EventLoop, _wakeupId: i32): void
```

_Undocumented._

### `eventLoopDrainWakeup`

```milo
fn eventLoopDrainWakeup(_el: &EventLoop, _wakeupId: i32): void
```

_Undocumented._

### `eventLoopFd`

```milo
fn eventLoopFd(el: &EventLoop): i32
```

_Undocumented._

### `eventLoopFromFd`

```milo
fn eventLoopFromFd(slot: i32): EventLoop
```

_Undocumented._

### `eventLoopInitWakeup`

```milo
fn eventLoopInitWakeup(el: &EventLoop): i32
```

Auto-reset Event, initially non-signaled. Auto-reset means a single wait consumes the
signal and there is nothing to drain; multiple notifies before a wait coalesce into one
wakeup, which is exactly right — a wakeup only means "re-check runnable state".

### `eventLoopNew`

```milo
fn eventLoopNew(): Result<EventLoop, string>
```

_Undocumented._

### `eventLoopNotify`

```milo
fn eventLoopNotify(el: &EventLoop, _wakeupId: i32): i32
```

safe from any thread: SetEvent is thread-safe, and the slot's wakeup handle was written at
init before this loop was reachable cross-thread.

### `eventPoll`

```milo
fn eventPoll(el: &EventLoop, readyFds: *i32, _maxEvents: i32, timeoutMs: i32): i32
```

poll the loop once. Waits up to timeoutMs (negative = block indefinitely) on the wakeup
Event and every registered socket's WSAEVENT together. On wake, reports the wakeup (if it
fired) plus every socket with a pending network event, as a flat fd list.

### `eventRegisterRead`

```milo
fn eventRegisterRead(el: &EventLoop, fd: i32): i32
```

_Undocumented._

### `eventRegisterWrite`

```milo
fn eventRegisterWrite(el: &EventLoop, fd: i32): i32
```

_Undocumented._

### `fionbio`

```milo
fn fionbio(): i32
```

FIONBIO = 0x8004667E as a signed 32-bit value.

### `maskRead`

```milo
fn maskRead(): i32
```

_Undocumented._

### `maskToNet`

```milo
fn maskToNet(mask: i32): i32
```

_Undocumented._

### `maskWrite`

```milo
fn maskWrite(): i32
```

_Undocumented._

### `setNonblocking`

```milo
fn setNonblocking(fd: i32): i32
```

_Undocumented._

### `wakeupIdentBase`

```milo
fn wakeupIdentBase(): i32
```

ident chosen far above any real fd so eventPoll consumers can tell a wakeup apart from fd
readiness in the same readyFds array (matches the darwin/linux convention).

### `winLoopTableCap`

```milo
fn winLoopTableCap(): i32
```

16 concurrent scheduler loops is far beyond any real program.

### `wlCap`

```milo
fn wlCap(): i64
```

_Undocumented._

### `wlGet`

```milo
fn wlGet(b: *u8, idx: i64): i64
```

_Undocumented._

### `wlMaskIdx`

```milo
fn wlMaskIdx(i: i64): i64
```

_Undocumented._

### `wlSet`

```milo
fn wlSet(b: *u8, idx: i64, v: i64): void
```

_Undocumented._

### `wlSize`

```milo
fn wlSize(): i64
```

_Undocumented._

### `wlSockIdx`

```milo
fn wlSockIdx(i: i64): i64
```

_Undocumented._

### `wlWevtIdx`

```milo
fn wlWevtIdx(i: i64): i64
```

_Undocumented._
