# std/event.linux

## std/event.linux

### `clearNonblocking`

```milo
fn clearNonblocking(fd: i32): i32
```

Clear O_NONBLOCK. fd 0/1/2 share an open file description with the parent
shell, so a non-blocking flag left set here leaks out and makes the shell's
reads return EAGAIN after we exit. Restore blocking mode before exiting.

### `efdCloexec`

```milo
fn efdCloexec(): i32
```

_Undocumented._

### `efdNonblock`

```milo
fn efdNonblock(): i32
```

_Undocumented._

### `epollEventSize`

```milo
fn epollEventSize(): i64
```

_Undocumented._

### `eventDeregister`

```milo
fn eventDeregister(el: &EventLoop, fd: i32, _forWrite: bool): i32
```

_Undocumented._

### `eventLoopClose`

```milo
fn eventLoopClose(el: &EventLoop): void
```

_Undocumented._

### `eventLoopCloseWakeup`

```milo
fn eventLoopCloseWakeup(el: &EventLoop, wakeupId: i32): void
```

_Undocumented._

### `eventLoopDrainWakeup`

```milo
fn eventLoopDrainWakeup(_el: &EventLoop, wakeupId: i32): void
```

eventfd is level-triggered under epoll; the counter must be consumed or
every subsequent poll reports it ready again

### `eventLoopFd`

```milo
fn eventLoopFd(el: &EventLoop): i32
```

_Undocumented._

### `eventLoopFromFd`

```milo
fn eventLoopFromFd(fd: i32): EventLoop
```

_Undocumented._

### `eventLoopInitWakeup`

```milo
fn eventLoopInitWakeup(el: &EventLoop): i32
```

_Undocumented._

### `eventLoopNew`

```milo
fn eventLoopNew(): Result<EventLoop, string>
```

_Undocumented._

### `eventLoopNotify`

```milo
fn eventLoopNotify(_el: &EventLoop, wakeupId: i32): i32
```

safe from any thread: write(2) on an eventfd is atomic

### `eventPoll`

```milo
fn eventPoll(el: &EventLoop, readyFds: *i32, maxEvents: i32, timeoutMs: i32): i32
```

poll for ready events. readyFds: caller-allocated *i32 array with capacity >= maxEvents.
returns count of ready fds, or -1 on error.
timeoutMs < 0 means block indefinitely.

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

### `setNonblocking`

```milo
fn setNonblocking(fd: i32): i32
```

_Undocumented._
