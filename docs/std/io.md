# std/io

## std/io

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `fdChannel`

```milo
fn fdChannel(fd: i32): Channel<string>
```

Stream a file descriptor's bytes on a background green task, returned as a
channel of raw chunks. This is the single pump behind every async byte source
(pty, sockets, child stdio, pipes) — the caller just `recv`s or iterates
(`for chunk in fdChannel(fd)`), never touching read/EAGAIN. The channel closes
at EOF (read returns <= 0). Milo's answer to a node.js Readable, minus the fd.

LIFETIME: the detached pump holds the raw fd. Keep the owning source (Pty /
TcpStream / Child) alive and open for as long as you consume the channel —
closing or dropping it out from under the pump strands the pump (parks
forever), and for a TLS source would read freed SSL state.

### `FdReader.readByte`

```milo
fn FdReader.readByte(self: &FdReader): i64
```

Read one byte, returned as 0..255. Returns -1 at EOF or on error.

### `FdReader.readExact`

```milo
fn FdReader.readExact(self: &FdReader, n: i64): Result<string>
```

Read exactly n bytes into a string. Err if the stream ends first.

### `fdReaderAttach`

```milo
fn fdReaderAttach(fd: i32): FdReader
```

Capture the read strategy from the current runtime context, flipping the fd
non-blocking iff we will park on it so the two never drift apart. Free fn (not
an FdReader method) because milo resolves `FdReader.attach` as a variant, not
a static method.

### `File.openAppend`

```milo
fn File.openAppend(path: &string): Result<File, IoError>
```

_Undocumented._

### `File.openRead`

```milo
fn File.openRead(path: &string): Result<File, IoError>
```

_Undocumented._

### `File.openWrite`

```milo
fn File.openWrite(path: &string): Result<File, IoError>
```

_Undocumented._

### `File.readAll`

```milo
fn File.readAll(self: &File): Result<string, IoError>
```

_Undocumented._

### `File.size`

```milo
fn File.size(self: &File): i64
```

_Undocumented._

### `File.writeAll`

```milo
fn File.writeAll(self: &File, data: &string): Result<i64, IoError>
```

_Undocumented._

### `putChar`

```milo
fn putChar(ch: u8): void
```

Write a single byte to stdout.

### `readFile`

```milo
fn readFile(path: &string): Result<string, IoError>
```

Read an entire file into a string. Returns an IoError (NotFound, permission,
etc.) rather than throwing; propagate with `?` or match on it.

### `readLine`

```milo
fn readLine(): Option<string>
```

Read a single line from stdin. Returns None at EOF.

### `readLines`

```milo
fn readLines(path: &string): Result<Vec<string>, IoError>
```

Read a file and return its contents as a Vec of lines.

### `readStdin`

```milo
fn readStdin(): string
```

Read all of stdin into a string (blocks to EOF). Prefer `stdinChannel()` for
streaming/incremental consumption.

### `splitLines`

```milo
fn splitLines(content: &string): Vec<string>
```

Split a string into lines on newline boundaries.

### `stdinChannel`

```milo
fn stdinChannel(): Channel<string>
```

Stream stdin as an iterable channel of chunks — the async counterpart to the
blocking readStdin/readLine. `for chunk in stdinChannel() { ... }`.
NOTE: this puts fd 0 into O_NONBLOCK and does not restore it, so afterward the
blocking readLine/readStdin on the same tty may return early. Pick one style
per stdin session; don't mix streaming and blocking reads of the same fd.

### `writeStdout`

```milo
fn writeStdout(s: &string): void
```

Write a string to stdout without appending a newline.

### `writeStr`

```milo
fn writeStr(s: &string): void
```

Write a string to stdout without a trailing newline.
