# std/signal

## std/signal

### `ignoreSignal`

```milo
fn ignoreSignal(sig: i32): void
```

Ignore a signal.

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
