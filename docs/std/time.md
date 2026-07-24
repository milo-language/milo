# std/time

## std/time

### `durationMicros`

```milo
pub fn durationMicros(d: &Duration): i64
```

_Undocumented._

### `durationMillis`

```milo
pub fn durationMillis(d: &Duration): i64
```

_Undocumented._

### `durationSecs`

```milo
pub fn durationSecs(d: &Duration): i64
```

Duration accessors.

### `elapsed`

```milo
pub fn elapsed(start: Instant, end: Instant): Duration
```

Elapsed time between two instants.

### `epochMillis`

```milo
pub fn epochMillis(): i64
```

Milliseconds since Unix epoch.

### `epochSecs`

```milo
pub fn epochSecs(): i64
```

Seconds since Unix epoch.

### `now`

```milo
pub fn now(): Instant
```

Capture the current wall-clock time.

### `readI64FromBuf`

```milo
fn readI64FromBuf(buf: &[u8; 16], off: i64): i64
```

_Undocumented._

### `since`

```milo
pub fn since(start: Instant): Duration
```

Elapsed time since an instant.

### `sleepMs`

```milo
pub fn sleepMs(ms: i64): void
```

Sleep for the given number of milliseconds.
Inside a green thread, yields cooperatively so other tasks keep running.

### `sleepSecs`

```milo
pub fn sleepSecs(secs: i64): void
```

Sleep for the given number of seconds.
