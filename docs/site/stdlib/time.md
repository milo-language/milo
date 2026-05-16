# std/time

Wall clock and high-resolution timing.

```milo
from "std/time" import { Instant, Duration, now, elapsed, since, sleepMs, epochMillis }
```

## Types

### Instant

```milo
struct Instant {
    sec: i64,
    usec: i64,
}
```

A point in time from the system clock.

### Duration

```milo
struct Duration {
    totalUsec: i64,
}
```

A span of time in microseconds.

## Functions

### now

```milo
fn now(): Instant
```

Returns the current time.

### epochMillis

```milo
fn epochMillis(): i64
```

Returns milliseconds since the Unix epoch.

### epochSecs

```milo
fn epochSecs(): i64
```

Returns seconds since the Unix epoch.

### elapsed

```milo
fn elapsed(start: Instant, end: Instant): Duration
```

Returns the duration between two instants.

### since

```milo
fn since(start: Instant): Duration
```

Returns the duration from `start` until now.

### durationSecs

```milo
fn durationSecs(d: &Duration): i64
```

Extracts whole seconds from a duration.

### durationMillis

```milo
fn durationMillis(d: &Duration): i64
```

Extracts whole milliseconds from a duration.

### durationMicros

```milo
fn durationMicros(d: &Duration): i64
```

Extracts microseconds from a duration.

### sleepMs

```milo
fn sleepMs(ms: i64)
```

Sleeps for the given number of milliseconds.

### sleepSecs

```milo
fn sleepSecs(secs: i64)
```

Sleeps for the given number of seconds.

## Example

```milo
let start = now()
// ... do work ...
let d = since(start)
print("took " + intToString(durationMillis(&d)) + "ms")
```
