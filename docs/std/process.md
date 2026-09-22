# std/process

## std/process

### `capture`

```milo
pub fn capture(cmd: &string): Result<string>
```

Run `cmd` through the shell and return its stdout and stderr, merged. Errs if the
command exits non-zero.

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
Only valid when stdout is a pipe (the default) rather than redirected elsewhere.

### `Child.signal`

```milo
fn Child.signal(self: &Child, sig: i32): Result<i32>
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

Stream the child's stderr the same way. Only valid when stderr is a
separate pipe (not merged into stdout).

### `Child.stdout`

```milo
fn Child.stdout(self: &Child): Channel<string>
```

Stream the child's stdout as an iterable channel, pumped on a background
green task — the uniform async-read API shared with pty/socket/pipe.
`for chunk in child.stdout()`; closes at EOF (child exits / closes stdout).
Only valid when stdout is a pipe (the default).

### `Child.wait`

```milo
fn Child.wait(self: &Child): Result<i32>
```

Block until the child exits and return its status. Inside a green task only this
task parks (see waitpidGreen); the rest of the scheduler keeps running.

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

Append one argument. Arguments are passed to the child verbatim — there is no
shell in the way, so quoting and globbing are neither needed nor performed.

### `Command.args`

```milo
fn Command.args(self: Command, values: &Vec<string>): Command
```

Append several arguments.

### `Command.dir`

```milo
fn Command.dir(self: Command, path: &string): Command
```

Run the child in `path` instead of the parent's working directory. A path the
child cannot enter fails the child with exit code 126 (the shell's "found but
could not execute"), reported by wait() like any other post-fork failure.

### `Command.env`

```milo
fn Command.env(self: Command, name: &string, value: &string): Command
```

Set `name` in the child's environment. Overrides an inherited value; the parent's
own environment is untouched, unlike Env.set.

### `Command.envClear`

```milo
fn Command.envClear(self: Command): Command
```

Start from an empty environment instead of inheriting the parent's. Variables set
with `env` afterwards — or before — still apply; this only drops what was inherited.
Note that a child with no PATH cannot itself find programs by name.

### `Command.envRemove`

```milo
fn Command.envRemove(self: Command, name: &string): Command
```

Remove `name` from the child's environment.

### `Command.new`

```milo
fn Command.new(program: &string): Command
```

A command that runs `program` (PATH-searched, like the shell) with no arguments.
The program name is borrowed and copied in: it is usually a long-lived constant.

### `Command.spawn`

```milo
fn Command.spawn(self: &Command): Result<Child>
```

Start the child and return immediately. On POSIX a program that does not exist is
reported by the child's exit status (127) rather than here — the exec only happens
after the fork, so spawn cannot know.

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

Absolute path of the running executable, so a shipped binary can locate assets
next to itself instead of relative to whatever cwd the caller happened to be in.
Prefer @embedFile() for assets small enough to inline; this is for the rest.

### `freeArgv`

```milo
pub fn freeArgv(argv: *u8, argc: i64): void
```

_Undocumented._

### `Process.signal`

```milo
fn Process.signal(self: &Process, sig: i32): Result<i32>
```

Send signal `sig` to the child. 0 on success.

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

Block until the child exits and return its status. Inside a green task only this
task parks (see waitpidGreen); the rest of the scheduler keeps running.

### `run`

```milo
pub fn run(cmd: &string): Result<i32>
```

Execute a shell command and return its exit code.
Example: let code = run("ls -la")!
