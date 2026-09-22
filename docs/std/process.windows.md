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

Only valid when stdout is a pipe (the default) rather than redirected elsewhere.

### `Child.signal`

```milo
fn Child.signal(self: &Child, _sig: i32): Result<i32>
```

_Undocumented._

### `Child.spawn`

```milo
fn Child.spawn(program: &string, args: &Vec<string>, mergeStderr: bool): Result<Child>
```

Spawn with both stdio pipes and nothing else configured. Shorthand for
`Command.new(program).args(args).stderr(...)` — use Command when the child needs
a working directory, an environment, or a stream pointed anywhere but a pipe.

### `Child.stderr`

```milo
fn Child.stderr(self: &Child): Channel<string>
```

_Undocumented._

### `Child.stdout`

```milo
fn Child.stdout(self: &Child): Channel<string>
```

Only valid when stdout is a pipe (the default).

### `Child.wait`

```milo
fn Child.wait(self: &Child): Result<i32>
```

_Undocumented._

### `Child.writeStdin`

```milo
fn Child.writeStdin(self: &Child, buf: *u8, len: i64): i64
```

Only valid while stdin is a pipe: Stdio.Inherit/Null/Read leave nothing for the
parent to write, and closeStdin() has already sent EOF.

### `Child.writeStdinStr`

```milo
fn Child.writeStdinStr(self: &Child, s: &string): i64
```

_Undocumented._

### `Command.arg`

```milo
fn Command.arg(self: Command, value: &string): Command
```

_Undocumented._

### `Command.args`

```milo
fn Command.args(self: Command, values: &Vec<string>): Command
```

_Undocumented._

### `Command.dir`

```milo
fn Command.dir(self: Command, path: &string): Command
```

Run the child in `path`. Unlike POSIX, a directory the child cannot enter fails
spawn() itself — CreateProcess validates it before the process exists.

### `Command.env`

```milo
fn Command.env(self: Command, name: &string, value: &string): Command
```

_Undocumented._

### `Command.envClear`

```milo
fn Command.envClear(self: Command): Command
```

_Undocumented._

### `Command.envRemove`

```milo
fn Command.envRemove(self: Command, name: &string): Command
```

_Undocumented._

### `Command.new`

```milo
fn Command.new(program: &string): Command
```

_Undocumented._

### `Command.spawn`

```milo
fn Command.spawn(self: &Command): Result<Child>
```

_Undocumented._

### `Command.stderr`

```milo
fn Command.stderr(self: Command, mode: Stdio): Command
```

Where the child's stderr goes. `Merge` (into stdout) by default.

### `Command.stdin`

```milo
fn Command.stdin(self: Command, mode: Stdio): Command
```

Where the child's stdin comes from. `Pipe` by default.

### `Command.stdout`

```milo
fn Command.stdout(self: Command, mode: Stdio): Command
```

Where the child's stdout goes. `Pipe` by default.

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

Start the program at `path` in the background, with no arguments and no shell.
For arguments, a working directory or redirection, use `Command`.

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
