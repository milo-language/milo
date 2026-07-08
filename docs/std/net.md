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

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `Drop.ip4`

```milo
fn Drop.ip4(a: u8, b: u8, c: u8, d: u8): u32
```

_Undocumented._

### `Response.decodeChunked`

```milo
fn Response.decodeChunked(rawBody: &string): string
```

_Undocumented._

### `Response.doFetch`

```milo
fn Response.doFetch(url: string, opts: FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `Response.fetch`

```milo
fn Response.fetch(url: &string): Result<Response, NetError>
```

_Undocumented._

### `Response.fetchDelete`

```milo
fn Response.fetchDelete(url: &string): Result<Response, NetError>
```

_Undocumented._

### `Response.fetchPatch`

```milo
fn Response.fetchPatch(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `Response.fetchPost`

```milo
fn Response.fetchPost(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `Response.fetchPut`

```milo
fn Response.fetchPut(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `Response.fetchWith`

```milo
fn Response.fetchWith(url: &string, opts: FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `Response.findHeader`

```milo
fn Response.findHeader(headers: &string, name: &string): string
```

_Undocumented._

### `Response.header`

```milo
fn Response.header(self: &Response, name: &string): string
```

Look up a response header by name (case-insensitive).

### `Response.hexDigit`

```milo
fn Response.hexDigit(c: u8): i64
```

_Undocumented._

### `Response.httpDo`

```milo
fn Response.httpDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `Response.httpsDo`

```milo
fn Response.httpsDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `Response.isHttps`

```milo
fn Response.isHttps(url: &string): bool
```

_Undocumented._

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

### `Response.parseBody`

```milo
fn Response.parseBody(raw: &string): string
```

_Undocumented._

### `Response.parseHost`

```milo
fn Response.parseHost(url: &string): string
```

_Undocumented._

### `Response.parsePath`

```milo
fn Response.parsePath(url: &string): string
```

_Undocumented._

### `Response.parsePort`

```milo
fn Response.parsePort(url: &string): u16
```

_Undocumented._

### `Response.parseRawHeaders`

```milo
fn Response.parseRawHeaders(raw: &string): string
```

_Undocumented._

### `Response.parseResponse`

```milo
fn Response.parseResponse(raw: string): Response
```

_Undocumented._

### `Response.parseStatus`

```milo
fn Response.parseStatus(raw: &string): i32
```

_Undocumented._

### `Response.schemeOffset`

```milo
fn Response.schemeOffset(url: &string): i64
```

_Undocumented._

### `Response.startsWith`

```milo
fn Response.startsWith(s: &string, prefix: &string): bool
```

_Undocumented._

### `Response.strEqNocase`

```milo
fn Response.strEqNocase(a: &string, ai: i64, b: &string, blen: i64): bool
```

_Undocumented._

### `Response.text`

```milo
fn Response.text(self: &Response): string
```

Return the response body as a string.

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

### `TcpStream.connect`

```milo
fn TcpStream.connect(ip: u32, port: u16): Result<TcpStream, NetError>
```

_Undocumented._

### `TcpStream.incoming`

```milo
fn TcpStream.incoming(self: &TcpStream): Channel<string>
```

Stream inbound bytes as an iterable channel, pumped on a background green
task — the uniform async-read API shared with pty/child/pipe. Iterate with
`for chunk in stream.incoming()`; the channel closes when the peer does.
(Plaintext only — TlsStream needs an SSL-aware pump.)

### `TcpStream.recv`

```milo
fn TcpStream.recv(self: &TcpStream): Result<string, NetError>
```

Read everything until the peer closes, as one string (blocks to EOF).
Prefer `incoming()` for streaming/incremental consumption — it delivers
chunks as they arrive instead of buffering the whole response.

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

### `TlsStream.recv`

```milo
fn TlsStream.recv(self: &TlsStream): Result<string, NetError>
```

Read everything until the peer closes, as one string (blocks to EOF).
Prefer `incoming()` for streaming/incremental consumption.

### `TlsStream.resolve`

```milo
fn TlsStream.resolve(hostname: &string): Result<u32, NetError>
```

_Undocumented._

### `TlsStream.send`

```milo
fn TlsStream.send(self: &TlsStream, data: &string): Result<i64, NetError>
```

_Undocumented._
