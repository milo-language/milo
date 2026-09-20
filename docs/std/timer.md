# std/timer

## std/timer

### `recvTimeout`

```milo
pub fn recvTimeout<T>(ch: &Channel<T>, d: &Duration): Option<T>
```

Receive from `ch`, giving up after `d`. None means the timeout won or the
channel closed empty.

A free function, not a method: Channel lives in std/sync, and an
`impl Channel<T>` here would be visible only to programs that already import
something from std/timer. A free function names its dependency.

### `Ticker.channel`

```milo
fn Ticker.channel(self: &Ticker): Channel<Instant>
```

The tick channel, for arming in a Select.

### `Ticker.every`

```milo
fn Ticker.every(period: &Duration): Ticker
```

Deliver an Instant every `period`. A slow receiver does not accumulate a
backlog: the buffer holds one tick and the sender drops any it can't
deposit, which is Go's behavior and the only one that can't grow without
bound.

A period of zero or less would be a hot loop, so it yields a Ticker that
never fires.

### `Ticker.recv`

```milo
fn Ticker.recv(self: &Ticker): Option<Instant>
```

Block for the next tick. None once the ticker is stopped and drained.

### `Ticker.stop`

```milo
fn Ticker.stop(self: &Ticker): void
```

Stop ticking. The task exits at its next wake, so up to one period later.
Idempotent.

### `Timer.after`

```milo
fn Timer.after(d: &Duration): Timer
```

Start a timer that delivers one Instant after `d`. The clock starts now,
not at the first recv.

### `Timer.channel`

```milo
fn Timer.channel(self: &Timer): Channel<Instant>
```

The delivery channel, for arming in a Select alongside other sources.

### `Timer.recv`

```milo
fn Timer.recv(self: &Timer): Option<Instant>
```

Block until the timer fires. None if it was stopped first.

### `Timer.stop`

```milo
fn Timer.stop(self: &Timer): void
```

Cancel. Idempotent; a timer that already fired is unaffected (its value is
still waiting in the channel).

### `waitReadable`

```milo
pub fn waitReadable(fd: i32, d: &Duration): bool
```

Wait until `fd` is readable, or `d` elapses. False on timeout.

This is the timeout under a blocking read: check first, then read knowing the
read won't park forever. It reads nothing itself.

### `waitWritable`

```milo
pub fn waitWritable(fd: i32, d: &Duration): bool
```

Wait until `fd` accepts a write without blocking, or `d` elapses.
