# std/signal

POSIX signal handling.

```milo
from "std/signal" import { onSignal, ignoreSignal, resetSignal, SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGABRT, SIGKILL, SIGALRM }
```

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `SIGHUP` | 1 | Hangup |
| `SIGINT` | 2 | Interrupt (Ctrl+C) |
| `SIGQUIT` | 3 | Quit |
| `SIGABRT` | 6 | Abort |
| `SIGKILL` | 9 | Kill (cannot be caught) |
| `SIGALRM` | 14 | Alarm timer |
| `SIGTERM` | 15 | Termination |

## Functions

### onSignal

```milo
fn onSignal(sig: i32, handler: fn(i32): void)
```

Register a handler function for the given signal. The handler receives the signal number.

### ignoreSignal

```milo
fn ignoreSignal(sig: i32)
```

Set the signal disposition to ignore. The signal will be silently discarded.

### resetSignal

```milo
fn resetSignal(sig: i32)
```

Reset the signal to its default disposition.

## Example

```milo
from "std/signal" import { onSignal, SIGINT, SIGTERM }

fn main(): i32 {
    onSignal(SIGINT, (sig: i32): void => {
        print("caught interrupt, cleaning up...")
        exit(0)
    })

    onSignal(SIGTERM, (sig: i32): void => {
        print("terminated")
        exit(0)
    })

    // main loop...
    return 0
}
```
