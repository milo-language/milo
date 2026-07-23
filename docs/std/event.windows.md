# std/event.windows

## std/event.windows

### `clearNonblocking`

```milo
fn clearNonblocking(fd: i32): i32
```

Restore blocking mode; same socket-only caveat as setNonblocking.

### `eventDeregister`

```milo
fn eventDeregister(_el: &EventLoop, _fd: i32, _forWrite: bool): i32
```

_Undocumented._

### `eventLoopClose`

```milo
fn eventLoopClose(el: &EventLoop): void
```

_Undocumented._

### `eventLoopCloseWakeup`

```milo
fn eventLoopCloseWakeup(_el: &EventLoop, _wakeupId: i32): void
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
fn eventLoopFromFd(fd: i32): EventLoop
```

_Undocumented._

### `eventLoopInitWakeup`

```milo
fn eventLoopInitWakeup(_el: &EventLoop): i32
```

Also init-time; there is no wakeup fd to create, and nothing polls for one.

### `eventLoopNew`

```milo
fn eventLoopNew(): Result<EventLoop, string>
```

Succeeds deliberately. std/runtime constructs a loop during scheduler init, which every
program importing std/io reaches — even one that only prints. Failing here would make
`print` itself unusable on Windows to report a limitation the program never hits. The
loop is inert: the operations that genuinely need IOCP abort when actually reached.

### `eventLoopNotify`

```milo
fn eventLoopNotify(_el: &EventLoop, _wakeupId: i32): i32
```

_Undocumented._

### `eventPoll`

```milo
fn eventPoll(_el: &EventLoop, _readyFds: *i32, _maxEvents: i32, _timeoutMs: i32): i32
```

_Undocumented._

### `eventRegisterRead`

```milo
fn eventRegisterRead(_el: &EventLoop, _fd: i32): i32
```

_Undocumented._

### `eventRegisterWrite`

```milo
fn eventRegisterWrite(_el: &EventLoop, _fd: i32): i32
```

_Undocumented._

### `fionbio`

```milo
fn fionbio(): i32
```

FIONBIO = 0x8004667E as a signed 32-bit value.

### `setNonblocking`

```milo
fn setNonblocking(fd: i32): i32
```

_Undocumented._

### `unsupported`

```milo
fn unsupported(what: &string): void
```

_Undocumented._
