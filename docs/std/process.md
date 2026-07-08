# std/process

## std/process

### `Child.capture`

```milo
fn Child.capture(cmd: &string): Result<string>
```

_Undocumented._

### `Child.close`

```milo
fn Child.close(self: &mut Child): void
```

Close any still-open parent-side fds. Call after wait().

### `Child.closeStdin`

```milo
fn Child.closeStdin(self: &mut Child): void
```

Close the child's stdin, sending EOF. Idempotent.

### `Child.readStderr`

```milo
fn Child.readStderr(self: &Child, buf: *u8, len: i64): i64
```

Low-level single read into a raw buffer. Prefer `stderr()` for streaming.

### `Child.readStdout`

```milo
fn Child.readStdout(self: &Child, buf: *u8, len: i64): i64
```

Low-level single read into a raw buffer. Prefer `stdout()` for streaming.

### `Child.signal`

```milo
fn Child.signal(self: &Child, sig: i32): Result<i32>
```

_Undocumented._

### `Child.spawn`

```milo
fn Child.spawn(program: &string, args: &Vec<string>, mergeStderr: bool): Result<Child>
```

_Undocumented._

### `Child.stderr`

```milo
fn Child.stderr(self: &Child): Channel<string>
```

Stream the child's stderr the same way. Only valid when stderr is a
separate pipe (not merged into stdout).

### `Child.stdout`

```milo
fn Child.stdout(self: &Child): Channel<string>
```

Stream the child's stdout as an iterable channel, pumped on a background
green task — the uniform async-read API shared with pty/socket/pipe.
`for chunk in child.stdout()`; closes at EOF (child exits / closes stdout).

### `Child.wait`

```milo
fn Child.wait(self: &Child): Result<i32>
```

_Undocumented._

### `Child.writeStdin`

```milo
fn Child.writeStdin(self: &Child, buf: *u8, len: i64): i64
```

_Undocumented._

### `Child.writeStdinStr`

```milo
fn Child.writeStdinStr(self: &Child, s: &string): i64
```

_Undocumented._

### `Process.signal`

```milo
fn Process.signal(self: &Process, sig: i32): Result<i32>
```

_Undocumented._

### `Process.spawn`

```milo
fn Process.spawn(path: &string): Result<Process>
```

_Undocumented._

### `Process.wait`

```milo
fn Process.wait(self: &Process): Result<i32>
```

_Undocumented._

### `run`

```milo
fn run(cmd: &string): Result<i32>
```

_Undocumented._
