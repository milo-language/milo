# std/process.windows

## std/process.windows

### `buildCmdLine`

```milo
pub fn buildCmdLine(program: &string, args: &Vec<string>): *u8
```

Build a single CreateProcess command line: `program arg1 arg2 ...`, each token quoted
if it contains whitespace or a quote. Returned buffer is malloc'd + NUL-terminated;
CreateProcessA may write into it, so it must be writable (not a string literal).

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

### `createProcess`

```milo
fn createProcess(program: &string, args: &Vec<string>, childIn: i32, childOut: i32, childErr: i32): Result<Process>
```

Core CreateProcess wrapper. childIn/Out/Err are child-side CRT fds already marked
inheritable, or -1 to leave that stream at the parent's (inherited console). Returns a
Process holding dwProcessId and the process HANDLE.

### `cstrCopy`

```milo
fn cstrCopy(s: &string): *u8
```

Copy a milo string into a fresh malloc'd NUL-terminated C buffer.

### `exePath`

```milo
pub fn exePath(): Result<string>
```

Absolute path of the running executable (mirror of the posix arm in std/process.milo;
this file replaces std/process.milo wholesale on Windows, so the surface must match).
`_exePathInto` resolves to GetModuleFileNameA in std/platform.windows.

### `handleFlagInherit`

```milo
fn handleFlagInherit(): u32
```

HANDLE_FLAG_INHERIT.

### `makeInheritable`

```milo
fn makeInheritable(fd: i32): void
```

_Undocumented._

### `pipeFlags`

```milo
fn pipeFlags(): i32
```

_O_BINARY (0x8000) so the CRT does not rewrite \n through the pipe, _O_NOINHERIT
(0x0080) so neither end is inheritable until we opt the child's end in by hand.
0x8080 = 32896; any other bit makes _pipe trip the CRT invalid-parameter fastfail.

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

### `quoteArg`

```milo
pub fn quoteArg(arg: &string): string
```

_Undocumented._

### `run`

```milo
pub fn run(cmd: &string): Result<i32>
```

Execute a shell command and return its exit code.

### `startfUseStdHandles`

```milo
fn startfUseStdHandles(): u32
```

STARTF_USESTDHANDLES — honour the hStdInput/Output/Error fields we set below.

### `waitHandle`

```milo
fn waitHandle(handle: i64): Result<i32>
```

Block on a process HANDLE and read its exit code. INFINITE = 0xFFFFFFFF.
