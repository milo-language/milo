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
call drainSignalFd after it wakes. One pipe per signal, so several can be armed at
once (SIGWINCH for resizes and SIGCHLD for child exits is the motivating pair).
Re-installing the same signal replaces its pipe.

### `onSignal`

```milo
fn onSignal(sig: i32, handler: *u8): void
```

Register a handler for a signal. The handler receives the signal number.

`handler` must be a top-level `fn (i32): void` passed as a raw pointer —
`onSignal(sigchld(), myHandler as *u8)` — NOT a closure. A C signal handler has no
user-data slot, so a captured environment has nowhere to live. This used to be typed
`(i32) => void`, which made it a closure whose code pointer takes (env, sig); C then
called it with the signal number in the env slot and the handler read garbage as its
`sig` (observed: 1794499728 instead of 20). Nothing caught it because the only in-tree
handler, _sigPipeHandler, ignores its argument.

### `resetSignal`

```milo
fn resetSignal(sig: i32): void
```

Reset a signal to default behavior.

### `sigchld`

```milo
fn sigchld(): i32
```

Child stopped or exited. A fn, not a `let` like its siblings above, for two reasons that
both bite: its number is NOT the same on both platforms (20 darwin / 17 linux, verified
against sys/signal.h and asm-generic/signal.h), so it has to come from the std/platform
split; and module-scope runtime initialization is rejected, so `let SIGCHLD = ...()`
cannot work at all — the checker catches that rather than letting it become 0.
This is what a child-exit Select arm needs: arm it through installSignalPipe and a
reaped child becomes just another readable fd.
