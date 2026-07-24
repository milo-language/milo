# std/process.windows

## std/process.windows

### `capture`

```milo
pub fn capture(cmd: &string): Result<string>
```

_Undocumented._

### `Child.close`

```milo
fn Child.close(self: &mut Child): void
```

_Undocumented._

### `Child.closeStdin`

```milo
fn Child.closeStdin(self: &mut Child): void
```

_Undocumented._

### `Child.readStderr`

```milo
fn Child.readStderr(self: &Child, buf: *u8, len: i64): i64
```

_Undocumented._

### `Child.readStdout`

```milo
fn Child.readStdout(self: &Child, buf: *u8, len: i64): i64
```

_Undocumented._

### `Child.signal`

```milo
fn Child.signal(self: &Child, _sig: i32): Result<i32>
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

_Undocumented._

### `Child.stdout`

```milo
fn Child.stdout(self: &Child): Channel<string>
```

_Undocumented._

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

### `exePath`

```milo
pub fn exePath(): Result<string>
```

Absolute path of the running executable (mirror of the posix arm in std/process.milo;
this file replaces std/process.milo wholesale on Windows, so the surface must match).
`_exePathInto` resolves to GetModuleFileNameA in std/platform.windows.

### `Process.signal`

```milo
fn Process.signal(self: &Process, _sig: i32): Result<i32>
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
pub fn run(cmd: &string): Result<i32>
```

Execute a shell command and return its exit code.
