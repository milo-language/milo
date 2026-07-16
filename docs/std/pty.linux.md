# std/pty.linux

## std/pty.linux

### `fdIsTerminal`

```milo
fn fdIsTerminal(fd: i32): bool
```

Returns true if fd is connected to a terminal.

### `isInteractive`

```milo
fn isInteractive(): bool
```

Returns true if stdin is a terminal (process is interactive).

### `Pty.close`

```milo
fn Pty.close(self: &mut Pty): void
```

Idempotent: closing the master also unwedges a child blocked writing to a
full PTY buffer (its write returns EIO), letting a pending SIGKILL land.

### `Pty.kill`

```milo
fn Pty.kill(self: &Pty): void
```

SIGKILL the child. Needed to tear down children that never exit on
their own (e.g. `while true` shells) before a blocking wait().

### `Pty.open`

```milo
fn Pty.open(): Result<Pty, string>
```

_Undocumented._

### `Pty.openAndSpawn`

```milo
fn Pty.openAndSpawn(program: &string, args: &Vec<string>): Result<Pty, string>
```

Convenience: open + spawn in one call

### `Pty.output`

```milo
fn Pty.output(self: &Pty): Channel<string>
```

Pump this pty's output on a background green task and return a channel of
raw output chunks. The caller only `recv`s the channel — no read(),
EAGAIN handling, or hand-written pump loop. The channel is closed when the
child exits (read returns <= 0). This is node-pty's `.onData` ergonomics
with green-task semantics underneath.

### `Pty.read`

```milo
fn Pty.read(self: &Pty, buf: *u8, len: i64): i64
```

Low-level single read into a raw buffer. Prefer `output()` for streaming —
it owns the read/EAGAIN pump and hands you an iterable channel of chunks.

### `Pty.resize`

```milo
fn Pty.resize(self: &mut Pty, rows: u16, cols: u16): i32
```

_Undocumented._

### `Pty.spawn`

```milo
fn Pty.spawn(self: &mut Pty, program: &string, args: &Vec<string>): Result<i32, string>
```

Spawn child connected to PTY.

### `Pty.wait`

```milo
fn Pty.wait(self: &Pty): i32
```

Wait for child to exit. Returns exit status.

### `Pty.winSize`

```milo
fn Pty.winSize(self: &Pty): WinSize
```

_Undocumented._

### `Pty.write`

```milo
fn Pty.write(self: &Pty, buf: *u8, len: i64): i64
```

_Undocumented._

### `Pty.writeStr`

```milo
fn Pty.writeStr(self: &Pty, s: &string): i64
```

_Undocumented._

### `tiocgwinsz`

```milo
fn tiocgwinsz(): i64
```

_Undocumented._

### `tiocsctty`

```milo
fn tiocsctty(): i64
```

_Undocumented._

### `tiocswinsz`

```milo
fn tiocswinsz(): i64
```

_Undocumented._
