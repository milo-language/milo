# std/process

Command execution and child process management.

```milo
from "std/process" import { Process, run, capture }
```

## Types

### Process

```milo
struct Process {
    pid: i32,
}
```

Handle to a spawned child process.

## Functions

### run

```milo
fn run(command: &string): Result<i32>
```

Execute a shell command and wait for it to finish. Returns the exit code.

### Process.spawn

```milo
fn Process.spawn(command: &string): Result<Process>
```

Start a command in the background without waiting. Returns a `Process` handle.

### p.wait

```milo
fn wait(self: &Process): Result<i32>
```

Block until the process exits. Returns the exit code.

### capture

```milo
fn capture(command: &string): Result<string>
```

Execute a command and return its stdout as a string.

### p.signal

```milo
fn signal(self: &Process, sig: i32): Result<i32>
```

Send a POSIX signal to the process. Returns 0 on success.

## Example

```milo
from "std/process" import { Process, run, capture }

fn main(): i32 {
    // Run and get exit code
    let code = run("echo hello")!

    // Capture output
    let output = capture("uname -s")!
    print(output)

    // Spawn and wait
    let proc = Process.spawn("sleep 1")!
    let exitCode = proc.wait()!

    return 0
}
```
