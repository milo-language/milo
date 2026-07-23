# std/pty.windows

## std/pty.windows

### `fdIsTerminal`

```milo
fn fdIsTerminal(fd: i32): bool
```

True if fd is attached to a console (the ConPTY analogue of isatty).

### `isInteractive`

```milo
fn isInteractive(): bool
```

_Undocumented._

### `openAndSpawn`

```milo
fn openAndSpawn(program: &string, args: &Vec<string>): Result<Pty, string>
```

_Undocumented._

### `Pty.close`

```milo
fn Pty.close(self: &mut Pty): void
```

_Undocumented._

### `Pty.kill`

```milo
fn Pty.kill(self: &Pty): void
```

_Undocumented._

### `Pty.open`

```milo
fn Pty.open(): Result<Pty, string>
```

_Undocumented._

### `Pty.output`

```milo
fn Pty.output(self: &Pty): Channel<string>
```

_Undocumented._

### `Pty.read`

```milo
fn Pty.read(self: &Pty, buf: *u8, len: i64): i64
```

_Undocumented._

### `Pty.resize`

```milo
fn Pty.resize(self: &mut Pty, rows: u16, cols: u16): i32
```

_Undocumented._

### `Pty.spawn`

```milo
fn Pty.spawn(self: &mut Pty, program: &string, args: &Vec<string>): Result<i32, string>
```

_Undocumented._

### `Pty.wait`

```milo
fn Pty.wait(self: &Pty): i32
```

_Undocumented._

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
