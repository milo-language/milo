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

### `File.putChar`

```milo
fn File.putChar(ch: u8): void
```

_Undocumented._

### `File.readAll`

```milo
fn File.readAll(self: &File): Result<string, IoError>
```

_Undocumented._

### `File.readFile`

```milo
fn File.readFile(path: &string): Result<string, IoError>
```

Read an entire file into a string. Returns an IoError (NotFound, permission,
etc.) rather than throwing; propagate with `?` or match on it.

### `File.readLine`

```milo
fn File.readLine(): Option<string>
```

_Undocumented._

### `File.readLines`

```milo
fn File.readLines(path: &string): Result<Vec<string>, IoError>
```

_Undocumented._

### `File.readStdin`

```milo
fn File.readStdin(): string
```

_Undocumented._

### `File.size`

```milo
fn File.size(self: &File): i64
```

_Undocumented._

### `File.splitLines`

```milo
fn File.splitLines(content: &string): Vec<string>
```

_Undocumented._

### `File.writeAll`

```milo
fn File.writeAll(self: &File, data: &string): Result<i64, IoError>
```

_Undocumented._

### `File.writeStr`

```milo
fn File.writeStr(s: &string): void
```

_Undocumented._

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

_Undocumented._
