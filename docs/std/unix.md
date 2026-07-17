# std/unix

## std/unix

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `UnixListener.accept`

```milo
fn UnixListener.accept(self: &UnixListener): Result<UnixStream, string>
```

Accept one connection. Inside the green scheduler this yields instead of blocking the
runtime — acceptFd is family-agnostic and already green-aware.

### `UnixListener.bind`

```milo
fn UnixListener.bind(path: &string): Result<UnixListener, string>
```

Bind to `path` and listen. bind() fails EADDRINUSE if the file already exists — even
one left by a crashed process that never cleaned up — so a stale socket file is
removed first. That is the standard dance, and it is why the path should live
somewhere only this daemon writes.

### `UnixListener.removeSocketFile`

```milo
fn UnixListener.removeSocketFile(path: &string): void
```

Remove a socket file. Dropping a UnixListener closes its fd but leaves the path behind.

### `UnixStream.connect`

```milo
fn UnixStream.connect(path: &string): Result<UnixStream, string>
```

Connect to a listening socket at `path`. Inside the green scheduler this yields
rather than blocking the whole runtime.

### `UnixStream.incoming`

```milo
fn UnixStream.incoming(self: &UnixStream): Channel<string>
```

Inbound bytes as an iterable channel, pumped on a green task — the same shape as
TcpStream.incoming.

### `UnixStream.recv`

```milo
fn UnixStream.recv(self: &UnixStream): Result<string, string>
```

Read until the peer closes. Prefer incoming() to consume as bytes arrive.

### `UnixStream.send`

```milo
fn UnixStream.send(self: &UnixStream, data: &string): Result<i64, string>
```

_Undocumented._

### `UnixStream.take`

```milo
fn UnixStream.take(self: &mut UnixStream): i32
```

Release the fd to the caller; this stream no longer closes it on drop.
