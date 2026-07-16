# std/signal

## std/signal

### `drainSignalFd`

```milo
fn drainSignalFd(fd: i32): void
```

Drain pending bytes from a signal self-pipe (call after its fd wakes a Select).

### `ignoreSignal`

```milo
fn ignoreSignal(sig: i32): void
```

Ignore a signal.

### `installSignalPipe`

```milo
fn installSignalPipe(sig: i32): i32
```

Install a self-pipe for `sig` and return its read fd (or -1 on failure). The
fd goes readable each time the signal fires; arm it with Select.onRead and
call drainSignalFd after it wakes. Single global pipe — one signal at a time
(SIGWINCH is the intended user).

### `onSignal`

```milo
fn onSignal(sig: i32, handler: (i32) => void): void
```

Register a handler for a signal. Handler receives the signal number.

### `resetSignal`

```milo
fn resetSignal(sig: i32): void
```

Reset a signal to default behavior.
