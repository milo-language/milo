# std/event.darwin

## std/event.darwin

### `clearNonblocking`

```milo
pub fn clearNonblocking(fd: i32): i32
```

Clear O_NONBLOCK. fd 0/1/2 share an open file description with the parent
shell, so a non-blocking flag left set here leaks out and makes the shell's
reads return EAGAIN after we exit. Restore blocking mode before exiting.

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
pub fn eventLoopCloseWakeup(el: &EventLoop, wakeupId: i32): void
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
pub fn eventLoopFromFd(fd: i32): EventLoop
```

_Undocumented._

### `eventLoopInitWakeup`

```milo
pub fn eventLoopInitWakeup(el: &EventLoop): i32
```

_Undocumented._

### `eventLoopNew`

```milo
pub fn eventLoopNew(): Result<EventLoop, string>
```

_Undocumented._

### `eventLoopNotify`

```milo
pub fn eventLoopNotify(el: &EventLoop, wakeupId: i32): i32
```

safe from any thread: kevent on a shared kqueue is thread-safe

### `eventPoll`

```milo
pub fn eventPoll(el: &EventLoop, readyFds: *i32, maxEvents: i32, timeoutMs: i32): i32
```

poll for ready events. readyFds: caller-allocated *i32 array with capacity >= maxEvents.
returns count of ready fds, or -1 on error.
timeoutMs < 0 means block indefinitely.

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

### `keventSize`

```milo
pub fn keventSize(): i64
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

ident chosen far above any real fd so eventPoll consumers can tell a wakeup
apart from fd readiness in the same readyFds array
