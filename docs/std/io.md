# std/io

## std/io

### `BufReader.new`

```milo
fn BufReader.new(inner: R): BufReader<R>
```

_Undocumented._

### `BufReader.readAll`

```milo
fn BufReader.readAll(self: &mut BufReader): Result<string, IoError>
```

Everything left, to end of stream.

### `BufReader.readByte`

```milo
fn BufReader.readByte(self: &mut BufReader): Result<i64, IoError>
```

Next byte as 0..255, or -1 at end of stream.

### `BufReader.readExact`

```milo
fn BufReader.readExact(self: &mut BufReader, n: i64): Result<string, IoError>
```

Exactly `n` bytes, or an error naming how many the stream actually had.

### `BufReader.readLine`

```milo
fn BufReader.readLine(self: &mut BufReader): Result<Option<string>, IoError>
```

One line without its terminator. Strips a trailing CR so CRLF input reads the
same as LF input. None at end of stream — the `while let` loop condition.

### `BufReader.readUntil`

```milo
fn BufReader.readUntil(self: &mut BufReader, delim: u8): Result<Option<string>, IoError>
```

Bytes up to (and consuming) `delim`, with the delimiter itself stripped.
None means the stream was already at its end; a final unterminated run comes
back as Some, so no input is ever silently discarded.

### `BufReader.withCapacity`

```milo
fn BufReader.withCapacity(inner: R, cap: i64): BufReader<R>
```

_Undocumented._

### `BufWriter.new`

```milo
fn BufWriter.new(inner: W): BufWriter<W>
```

_Undocumented._

### `BufWriter.pending`

```milo
fn BufWriter.pending(self: &BufWriter): i64
```

Buffered bytes not yet handed down.

### `BufWriter.withCapacity`

```milo
fn BufWriter.withCapacity(inner: W, cap: i64): BufWriter<W>
```

_Undocumented._

### `BufWriter.writeByte`

```milo
fn BufWriter.writeByte(self: &mut BufWriter, b: u8): Result<Unit, IoError>
```

_Undocumented._

### `BufWriter.writeLine`

```milo
fn BufWriter.writeLine(self: &mut BufWriter, line: &string): Result<Unit, IoError>
```

_Undocumented._

### `BytesReader.new`

```milo
fn BytesReader.new(data: string): BytesReader
```

_Undocumented._

### `BytesReader.remaining`

```milo
fn BytesReader.remaining(self: &BytesReader): i64
```

_Undocumented._

### `BytesWriter.len`

```milo
fn BytesWriter.len(self: &BytesWriter): i64
```

_Undocumented._

### `BytesWriter.new`

```milo
fn BytesWriter.new(): BytesWriter
```

_Undocumented._

### `BytesWriter.take`

```milo
fn BytesWriter.take(self: &mut BytesWriter): string
```

Take the accumulated bytes out, leaving the writer empty and reusable.

### `copyStream`

```milo
pub fn copyStream<R: Reader, W: Writer>(src: &mut R, dst: &mut W): Result<i64, IoError>
```

Drain `src` into `dst`, returning the byte count. The pipe that makes any source
usable with any sink. Does NOT flush `dst` — a caller stacking more onto the same
writer should not pay for a flush per copy.

### `defaultBufferSize`

```milo
pub fn defaultBufferSize(): i64
```

Default buffer size for BufReader/BufWriter. Big enough that per-byte and
per-line work amortizes to roughly one syscall per 64 KiB.

### `fdChannel`

```milo
pub fn fdChannel(fd: i32): Channel<string>
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
pub fn fdReaderAttach(fd: i32): FdReader
```

Capture the read strategy from the current runtime context, flipping the fd
non-blocking iff we will park on it so the two never drift apart. Free fn (not
an FdReader method) because milo resolves `FdReader.attach` as a variant, not
a static method.

### `FdStream.onFd`

```milo
fn FdStream.onFd(fd: i32): FdStream
```

A CRT file descriptor: file, pipe, tty, pty.

### `FdStream.onSocket`

```milo
fn FdStream.onSocket(fd: i32): FdStream
```

A socket handle. Not interchangeable with `onFd` on Windows.

### `FdStream.rawFd`

```milo
fn FdStream.rawFd(self: &FdStream): i32
```

_Undocumented._

### `FdStream.stderr`

```milo
fn FdStream.stderr(): FdStream
```

_Undocumented._

### `FdStream.stdin`

```milo
fn FdStream.stdin(): FdStream
```

_Undocumented._

### `FdStream.stdout`

```milo
fn FdStream.stdout(): FdStream
```

Writes here go straight at fd 1, bypassing the stdio buffer `print` uses, so
the two interleave in the wrong order. Pick one per output session — that is
why this does not fflush on your behalf: doing so per write would defeat the
buffering you wrapped it in a BufWriter to get.

### `File.close`

```milo
fn File.close(self: &mut File): Result<Unit, IoError>
```

Close now instead of at drop, and report failure. Drop closes silently, which
is fine for reads but hides a write error that only surfaces at close (NFS,
full filesystems). After this the File is inert and its drop is a no-op.

### `File.openAppend`

```milo
fn File.openAppend(path: &string): Result<File, IoError>
```

Open a file for appending, creating it if missing (mode 0644).

### `File.openRead`

```milo
fn File.openRead(path: &string): Result<File, IoError>
```

Open a file for reading.

### `File.openWrite`

```milo
fn File.openWrite(path: &string): Result<File, IoError>
```

Open a file for writing, creating it or truncating it (mode 0644).

### `File.rawFd`

```milo
fn File.rawFd(self: &File): i32
```

Borrow the fd without transferring ownership — the File still closes it on
drop. For handing the fd to an fd-taking API; do not close it yourself.

### `File.readAll`

```milo
fn File.readAll(self: &File): Result<string, IoError>
```

_Undocumented._

### `File.seek`

```milo
fn File.seek(self: &File, pos: i64): Result<i64, IoError>
```

Move the read/write cursor to an absolute byte offset. Returns the new
offset. A BufReader over this file caches bytes past its own cursor, so
seeking underneath one desynchronizes it — seek first, then wrap.

### `File.size`

```milo
fn File.size(self: &File): i64
```

Size of the open file in bytes. The read position is left where it was.

### `File.stream`

```milo
fn File.stream(self: &File): FdStream
```

A non-owning Reader+Writer view of this file, for when the File itself must
stay put (e.g. you want a BufReader and a BufWriter on the same handle).
The File must outlive the view and the compiler does not check that — see
FdStream. Prefer `BufReader<File>.new(f)`, which owns the handle outright.

### `File.tell`

```milo
fn File.tell(self: &File): i64
```

Current cursor offset, or -1 for a stream that cannot report one (pipe, tty).

### `File.writeAll`

```milo
fn File.writeAll(self: &File, data: &string): Result<i64, IoError>
```

_Undocumented._

### `ioError`

```milo
pub fn ioError(path: &string): IoError
```

map errno to IoError variant with path context

### `putChar`

```milo
pub fn putChar(ch: u8): void
```

Write a single byte to stdout.

Goes onto the same stdio buffer `print` writes to — one syscall per byte would be
absurd for a per-character API, and a raw fd write would also land ahead of any
buffered `print` output.

### `Reader.read`

```milo
fn Reader.read(self: &mut Reader, max: i64): Result<string, IoError>
```

_Undocumented._

### `Reader.read`

```milo
fn Reader.read(self: &mut Reader, max: i64): Result<string, IoError>
```

_Undocumented._

### `Reader.read`

```milo
fn Reader.read(self: &mut Reader, max: i64): Result<string, IoError>
```

_Undocumented._

### `Reader.read`

```milo
fn Reader.read(self: &mut Reader, max: i64): Result<string, IoError>
```

_Undocumented._

### `readLine`

```milo
pub fn readLine(): Option<string>
```

Read a single line from stdin. Returns None at EOF.

### `readStdin`

```milo
pub fn readStdin(): string
```

Read all of stdin into a string (blocks to EOF). Prefer `stdinChannel()` for
streaming/incremental consumption.

### `stdinChannel`

```milo
pub fn stdinChannel(): Channel<string>
```

Stream stdin as an iterable channel of chunks — the async counterpart to the
blocking readStdin/readLine. `for chunk in stdinChannel() { ... }`.
NOTE: this puts fd 0 into O_NONBLOCK and does not restore it, so afterward the
blocking readLine/readStdin on the same tty may return early. Pick one style
per stdin session; don't mix streaming and blocking reads of the same fd.

### `Writer.flush`

```milo
fn Writer.flush(self: &mut Writer): Result<Unit, IoError>
```

No-op: this layer holds no buffer. Use `syncFd` from std/fs to force the
kernel's page cache out to the device.

### `Writer.flush`

```milo
fn Writer.flush(self: &mut Writer): Result<Unit, IoError>
```

No-op: the kernel owns the buffering below this point.

### `Writer.flush`

```milo
fn Writer.flush(self: &mut Writer): Result<Unit, IoError>
```

_Undocumented._

### `Writer.flush`

```milo
fn Writer.flush(self: &mut Writer): Result<Unit, IoError>
```

_Undocumented._

### `Writer.write`

```milo
fn Writer.write(self: &mut Writer, data: &string): Result<Unit, IoError>
```

_Undocumented._

### `Writer.write`

```milo
fn Writer.write(self: &mut Writer, data: &string): Result<Unit, IoError>
```

_Undocumented._

### `Writer.write`

```milo
fn Writer.write(self: &mut Writer, data: &string): Result<Unit, IoError>
```

_Undocumented._

### `Writer.write`

```milo
fn Writer.write(self: &mut Writer, data: &string): Result<Unit, IoError>
```

_Undocumented._

### `writeStdout`

```milo
pub fn writeStdout(s: &string): void
```

Write a string to stdout without appending a newline.

`print` goes through stdio's buffer; this goes straight at the fd. Drain the
buffer first or the two interleave in the wrong order. fflush on an already-empty
buffer is not a syscall, so a program that only ever uses this pays nothing.
