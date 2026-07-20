# std/net

## std/net

### `decodeChunked`

```milo
fn decodeChunked(rawBody: &string): string
```

_Undocumented._

### `doFetch`

```milo
fn doFetch(url: string, opts: FetchOptions): Result<Response, NetError>
```

_Undocumented._

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

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `fetch`

```milo
fn fetch(url: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchDelete`

```milo
fn fetchDelete(url: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchPatch`

```milo
fn fetchPatch(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchPost`

```milo
fn fetchPost(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchPut`

```milo
fn fetchPut(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchWith`

```milo
fn fetchWith(url: &string, opts: FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `findHeader`

```milo
fn findHeader(headers: &string, name: &string): string
```

_Undocumented._

### `hexDigit`

```milo
fn hexDigit(c: u8): i64
```

_Undocumented._

### `httpDo`

```milo
fn httpDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `httpsDo`

```milo
fn httpsDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError>
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

### `isHttps`

```milo
fn isHttps(url: &string): bool
```

_Undocumented._

### `parseBody`

```milo
fn parseBody(raw: &string): string
```

_Undocumented._

### `parseHost`

```milo
fn parseHost(url: &string): string
```

_Undocumented._

### `parsePath`

```milo
fn parsePath(url: &string): string
```

_Undocumented._

### `parsePort`

```milo
fn parsePort(url: &string): u16
```

_Undocumented._

### `parseRawHeaders`

```milo
fn parseRawHeaders(raw: &string): string
```

_Undocumented._

### `parseResponse`

```milo
fn parseResponse(raw: string): Response
```

_Undocumented._

### `parseStatus`

```milo
fn parseStatus(raw: &string): i32
```

_Undocumented._

### `resolve`

```milo
fn resolve(hostname: &string): Result<u32, NetError>
```

_Undocumented._

### `Response.header`

```milo
fn Response.header(self: &Response, name: &string): string
```

Look up a response header by name (case-insensitive).

### `Response.json`

```milo
fn Response.json(self: &Response): Json
```

Parse the response body as JSON.

### `Response.ok`

```milo
fn Response.ok(self: &Response): bool
```

Return true if the status code is 2xx (success).

### `Response.text`

```milo
fn Response.text(self: &Response): string
```

Return the response body as a string.

### `schemeOffset`

```milo
fn schemeOffset(url: &string): i64
```

_Undocumented._

### `startsWith`

```milo
fn startsWith(s: &string, prefix: &string): bool
```

_Undocumented._

### `strEqNocase`

```milo
fn strEqNocase(a: &string, ai: i64, b: &string, blen: i64): bool
```

_Undocumented._

### `TcpListener.accept`

```milo
fn TcpListener.accept(self: &TcpListener): Result<TcpStream, NetError>
```

Accept one connection. Inside the green scheduler this yields (via the
event loop) until a client is ready rather than blocking the whole
runtime; outside it, it blocks.

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

### `TlsStream.connect`

```milo
fn TlsStream.connect(ip: u32, port: u16, hostname: &string): Result<TlsStream, NetError>
```

_Undocumented._

### `TlsStream.incoming`

```milo
fn TlsStream.incoming(self: &TlsStream): Channel<string>
```

Stream decrypted inbound bytes as an iterable channel, pumped on a green
task — the uniform async-read API, TLS variant. Uses the SSL-aware read
(parks on WANT_READ) rather than the raw-fd fdChannel. `for chunk in
tls.incoming()`; the channel closes at EOF / on SSL error.
LIFETIME: keep this TlsStream alive while consuming — the detached pump
reads through its SSL handle; dropping it frees that state under the pump.

### `TlsStream.recv`

```milo
fn TlsStream.recv(self: &TlsStream): Result<string, NetError>
```

Read everything until the peer closes, as one string (blocks to EOF).
Prefer `incoming()` for streaming/incremental consumption.

### `TlsStream.send`

```milo
fn TlsStream.send(self: &TlsStream, data: &string): Result<i64, NetError>
```

_Undocumented._
