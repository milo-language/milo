# std/event.linux

## std/event.linux

### `clearNonblocking`

```milo
pub fn clearNonblocking(fd: i32): i32
```

Clear O_NONBLOCK. fd 0/1/2 share an open file description with the parent
shell, so a non-blocking flag left set here leaks out and makes the shell's
reads return EAGAIN after we exit. Restore blocking mode before exiting.

### `efdCloexec`

```milo
pub fn efdCloexec(): i32
```

_Undocumented._

### `efdNonblock`

```milo
pub fn efdNonblock(): i32
```

_Undocumented._

### `epollEventSize`

```milo
pub fn epollEventSize(): i64
```

_Undocumented._

### `eventDeregister`

```milo
pub fn eventDeregister(el: &EventLoop, fd: i32, _forWrite: bool): i32
```

Stop watching `fd`. `forWrite` picks the write registration rather than the read one.

### `EventLoop.new`

```milo
fn EventLoop.new(): Result<EventLoop, string>
```

Create a poller. Errs if the kernel will not hand one out.

### `eventLoopClose`

```milo
pub fn eventLoopClose(el: &EventLoop): void
```

Release the poller.

### `eventLoopCloseWakeup`

```milo
pub fn eventLoopCloseWakeup(el: &EventLoop, wakeupId: i32): void
```

Tear down a wakeup made by eventLoopInitWakeup.

### `eventLoopDrainWakeup`

```milo
pub fn eventLoopDrainWakeup(_el: &EventLoop, wakeupId: i32): void
```

eventfd is level-triggered under epoll; the counter must be consumed or
every subsequent poll reports it ready again

### `eventLoopFd`

```milo
pub fn eventLoopFd(el: &EventLoop): i32
```

The poller's descriptor, to hand to another runtime's poller when embedding.

### `eventLoopFromFd`

```milo
pub fn eventLoopFromFd(fd: i32): EventLoop
```

Wrap a poller that another runtime already owns. Does not take ownership: closing it
is still the original owner's job.

### `eventLoopInitWakeup`

```milo
pub fn eventLoopInitWakeup(el: &EventLoop): i32
```

Arm a wakeup that breaks a blocked `eventPoll` from elsewhere; this is how a
`Promise.blocking` worker tells the scheduler its result is ready. Returns the id to
pass to eventLoopNotify, eventLoopDrainWakeup and eventLoopCloseWakeup.

### `eventLoopNotify`

```milo
pub fn eventLoopNotify(_el: &EventLoop, wakeupId: i32): i32
```

safe from any thread: write(2) on an eventfd is atomic

### `eventPoll`

```milo
pub fn eventPoll(el: &EventLoop, readyFds: *i32, maxEvents: i32, timeoutMs: i32): i32
```

poll for ready events. readyFds: caller-allocated *i32 array with capacity >= maxEvents.
returns count of ready fds, or -1 on error.
timeoutMs < 0 means block indefinitely.

A fixed `[i32; N]` array passes bare: it coerces to `*i32`.

### `eventRegisterRead`

```milo
pub fn eventRegisterRead(el: &EventLoop, fd: i32): i32
```

Watch `fd` for readability.

### `eventRegisterWrite`

```milo
pub fn eventRegisterWrite(el: &EventLoop, fd: i32): i32
```

Watch `fd` for writability.

### `setNonblocking`

```milo
pub fn setNonblocking(fd: i32): i32
```

Make `fd` non-blocking. 0 on success, -1 on error. Register only non-blocking fds: a
poller that reports ready and then hangs in `read` is the usual symptom otherwise,
because readiness says a byte was available, not that the next read will return.
