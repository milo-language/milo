# std/time

## std/time

### `Duration.abs`

```milo
fn Duration.abs(self: &Duration): Duration
```

_Undocumented._

### `Duration.compare`

```milo
fn Duration.compare(self: &Duration, other: &Duration): i64
```

-1, 0 or 1. `==` and `!=` come from @derive(Eq); Milo has no Ord trait, so
ordering is spelled out.

### `Duration.days`

```milo
fn Duration.days(n: i64): Duration
```

_Undocumented._

### `Duration.dividedBy`

```milo
fn Duration.dividedBy(self: &Duration, k: i64): Duration
```

Divide by an integer factor, truncating toward zero. `k == 0` traps like
any other division by zero.

### `Duration.hours`

```milo
fn Duration.hours(n: i64): Duration
```

_Undocumented._

### `Duration.isGreater`

```milo
fn Duration.isGreater(self: &Duration, other: &Duration): bool
```

_Undocumented._

### `Duration.isLess`

```milo
fn Duration.isLess(self: &Duration, other: &Duration): bool
```

_Undocumented._

### `Duration.isNegative`

```milo
fn Duration.isNegative(self: &Duration): bool
```

_Undocumented._

### `Duration.isZero`

```milo
fn Duration.isZero(self: &Duration): bool
```

_Undocumented._

### `Duration.micros`

```milo
fn Duration.micros(n: i64): Duration
```

_Undocumented._

### `Duration.millis`

```milo
fn Duration.millis(n: i64): Duration
```

_Undocumented._

### `Duration.mins`

```milo
fn Duration.mins(n: i64): Duration
```

_Undocumented._

### `Duration.nanos`

```milo
fn Duration.nanos(n: i64): Duration
```

_Undocumented._

### `Duration.negated`

```milo
fn Duration.negated(self: &Duration): Duration
```

_Undocumented._

### `Duration.parse`

```milo
fn Duration.parse(text: &string): Option<Duration>
```

Parse a Go-style duration: a sign, then one or more `<number><unit>`
components, e.g. "300ms", "1h30m", "-1.5h", "2h45m10.5s". Units are ns,
us (or µs), ms, s, m, h and d. "0" alone is accepted.

Returns Option, not Result: every way this fails — a stray character, a
missing unit, a value past ±292 years — leaves the caller with the same
move (reject the input and echo it back), and a duration string is short
enough that a byte offset tells a user nothing their own eyes don't.

### `Duration.ratio`

```milo
fn Duration.ratio(self: &Duration, other: &Duration): f64
```

How many times `other` fits in self, as a ratio. The answer to "divide a
duration by a duration", which has no Duration result.

### `Duration.secs`

```milo
fn Duration.secs(n: i64): Duration
```

_Undocumented._

### `Duration.times`

```milo
fn Duration.times(self: &Duration, k: i64): Duration
```

Scale by an integer factor. Milo's operator overloading is homogeneous
(`Mul` is `Self × Self`), and a Duration times a Duration is meaningless,
so scaling is a method rather than `*`.

### `Duration.toHours`

```milo
fn Duration.toHours(self: &Duration): i64
```

Whole hours, truncated toward zero.

### `Duration.toMicros`

```milo
fn Duration.toMicros(self: &Duration): i64
```

Whole microseconds, truncated toward zero.

### `Duration.toMillis`

```milo
fn Duration.toMillis(self: &Duration): i64
```

Whole milliseconds, truncated toward zero.

### `Duration.toMillisF64`

```milo
fn Duration.toMillisF64(self: &Duration): f64
```

_Undocumented._

### `Duration.toMins`

```milo
fn Duration.toMins(self: &Duration): i64
```

Whole minutes, truncated toward zero.

### `Duration.toNanos`

```milo
fn Duration.toNanos(self: &Duration): i64
```

Whole nanoseconds.

### `Duration.toSecs`

```milo
fn Duration.toSecs(self: &Duration): i64
```

Whole seconds, truncated toward zero.

### `Duration.toSecsF64`

```milo
fn Duration.toSecsF64(self: &Duration): f64
```

Fractional seconds — the spelling for reporting a measurement.

### `Duration.toString`

```milo
fn Duration.toString(self: &Duration): string
```

Go-style: "0s", "1.5ms", "2m3.5s", "1h30m0s". Round-trips through
Duration.parse.

Deviation from Go: microseconds print as "us", not "µs", so the output is
ASCII everywhere it lands (log lines, filenames, terminals with a broken
locale). Parse accepts both.

### `Duration.zero`

```milo
fn Duration.zero(): Duration
```

_Undocumented._

### `elapsed`

```milo
pub fn elapsed(start: Instant, end: Instant): Duration
```

Elapsed time between two instants.

### `ensureTimersLive`

```milo
pub fn ensureTimersLive(): void
```

Make the green scheduler exist so timer and fd arms are live even on a program
that has not spawned a task. std/timer's timeouts call this; it is exported for
callers that arm a Select on the main context themselves.

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

### `since`

```milo
pub fn since(start: Instant): Duration
```

Elapsed time since an instant.

### `sleepFor`

```milo
pub fn sleepFor(d: &Duration): void
```

Sleep for a Duration. Sub-millisecond spans round up to 1 ms once a scheduler
exists — the event loop's deadlines are milliseconds, and rounding down would
turn a 100 µs sleep into a busy spin.

### `sleepMs`

```milo
pub fn sleepMs(ms: i64): void
```

Sleep for the given number of milliseconds.

With a scheduler running, this parks on a select timer arm: the caller is off
the run queue for the whole interval and every other green task keeps running.
Without one, it is a plain usleep.

### `sleepSecs`

```milo
pub fn sleepSecs(secs: i64): void
```

Sleep for the given number of seconds.
