# std/net

## std/net

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

### `ignoreSigpipe`

```milo
fn ignoreSigpipe(): void
```

_Undocumented._

### `ip4`

```milo
fn ip4(a: u8, b: u8, c: u8, d: u8): u32
```

_Undocumented._

### `ip6`

```milo
fn ip6(text: &string): Option<[u8; 16]>
```

Construct an IPv4 address from four octets.
Example: ip4(127, 0, 0, 1) for localhost.
Parse an IPv6 literal ("::1", "2001:db8::1") into its 16 raw bytes.
None if the text isn't a valid v6 address — inet_pton is strict, and a v4 literal like
"127.0.0.1" is NOT auto-mapped, so it returns None here rather than a v4-mapped address.

### `resolve`

```milo
fn resolve(hostname: &string): Result<u32, NetError>
```

_Undocumented._

### `TcpListener.accept`

```milo
fn TcpListener.accept(self: &TcpListener): Result<TcpStream, NetError>
```

Accept one connection. Inside the green scheduler this yields (via the
event loop) until a client is ready rather than blocking the whole
runtime; outside it, it blocks.

### `TcpListener.acceptNb`

```milo
fn TcpListener.acceptNb(self: &TcpListener): Result<TcpStream, NetError>
```

Accept without parking: Ok(stream) only when a connection is already
pending, Err otherwise. For callers that multiplex accept with other
event sources — accept() parks the calling task on the listener, which
stalls everything else that task drives until a client connects.

### `TcpListener.bind`

```milo
fn TcpListener.bind(port: u16): Result<TcpListener, NetError>
```

Bind to 0.0.0.0:port and start listening. SO_REUSEADDR is set so a quick
restart doesn't fail with "address already in use". Pass port 0 to let the
OS choose a free port (recover it via the accepted peer or getsockname).

### `TcpListener.bind6`

```milo
fn TcpListener.bind6(addr: [u8; 16], port: u16): Result<TcpListener, NetError>
```

Bind an IPv6 listener. Added alongside bind(); pass the 16 raw bytes (`ip6("::1")`,
or all-zero for the v6 wildcard "::").

### `TcpStream.connect`

```milo
fn TcpStream.connect(ip: u32, port: u16): Result<TcpStream, NetError>
```

_Undocumented._

### `TcpStream.connect6`

```milo
fn TcpStream.connect6(addr: [u8; 16], port: u16, scopeId: u32): Result<TcpStream, NetError>
```

IPv6 connect. Added alongside connect() rather than replacing it: a u32 cannot hold
a 128-bit address, so the v4 entry point keeps its shape. `scopeId` is the interface
index for a link-local peer (fe80::/10), 0 otherwise.

### `TcpStream.incoming`

```milo
fn TcpStream.incoming(self: &TcpStream): Channel<string>
```

Stream inbound bytes as an iterable channel, pumped on a background green
task — the uniform async-read API shared with pty/child/pipe. Iterate with
`for chunk in stream.incoming()`; the channel closes when the peer does.
(Plaintext only — TlsStream needs an SSL-aware pump.)

### `TcpStream.rawFd`

```milo
fn TcpStream.rawFd(self: &TcpStream): i32
```

Borrow the underlying fd read-only, WITHOUT transferring ownership: the stream
still closes it on drop. Use when you want to do a bounded read/write on the raw
fd and let the stream's own Drop close it — avoids `take()` (which needs `&mut`,
forcing a move out of an immutable match binding) and the manual close that pairs
with it. Do not close the returned fd yourself.

### `TcpStream.recv`

```milo
fn TcpStream.recv(self: &TcpStream): Result<string, NetError>
```

Read everything until the peer closes, as one string (blocks to EOF).
Prefer `incoming()` for streaming/incremental consumption — it delivers
chunks as they arrive instead of buffering the whole response.

### `TcpStream.recvOnce`

```milo
fn TcpStream.recvOnce(self: &TcpStream): string
```

A single read of whatever is currently available, unlike `recv()` which loops until
the peer closes. A keep-alive HTTP client never closes its write half while waiting
for the response, so `recv()` would deadlock; this returns after one segment — enough
for a request's headers.

### `TcpStream.send`

```milo
fn TcpStream.send(self: &TcpStream, data: &string): Result<i64, NetError>
```

_Undocumented._

### `TcpStream.take`

```milo
fn TcpStream.take(self: &mut TcpStream): i32
```

Release the underlying fd to the caller. After this the stream no longer
closes it on drop — hand it to an fd-based API (e.g. a WebSocket upgrade)
without risking a double close.
