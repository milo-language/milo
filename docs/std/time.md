# std/time

## std/time

### `durationMicros`

```milo
fn durationMicros(d: &Duration): i64
```

_Undocumented._

### `durationMillis`

```milo
fn durationMillis(d: &Duration): i64
```

_Undocumented._

### `durationSecs`

```milo
fn durationSecs(d: &Duration): i64
```

Duration accessors.

### `elapsed`

```milo
fn elapsed(start: Instant, end: Instant): Duration
```

Elapsed time between two instants.

### `epochMillis`

```milo
fn epochMillis(): i64
```

Milliseconds since Unix epoch.

### `epochSecs`

```milo
fn epochSecs(): i64
```

Seconds since Unix epoch.

### `now`

```milo
fn now(): Instant
```

Capture the current wall-clock time.

### `since`

```milo
fn since(start: Instant): Duration
```

Elapsed time since an instant.

### `sleepMs`

```milo
fn sleepMs(ms: i64): void
```

Sleep for the given number of milliseconds.
Inside a green thread, yields cooperatively so other tasks keep running.

### `sleepSecs`

```milo
fn sleepSecs(secs: i64): void
```

Sleep for the given number of seconds.
