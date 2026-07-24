# std/fetch

## std/fetch

### `decodeChunked`

```milo
pub fn decodeChunked(rawBody: &string): string
```

_Undocumented._

### `doFetch`

```milo
pub fn doFetch(url: string, opts: FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `fetch`

```milo
pub fn fetch(url: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchDelete`

```milo
pub fn fetchDelete(url: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchPatch`

```milo
pub fn fetchPatch(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchPost`

```milo
pub fn fetchPost(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchPut`

```milo
pub fn fetchPut(url: &string, body: &string): Result<Response, NetError>
```

_Undocumented._

### `fetchWith`

```milo
pub fn fetchWith(url: &string, opts: FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `findHeader`

```milo
pub fn findHeader(headers: &string, name: &string): string
```

_Undocumented._

### `hexDigit`

```milo
pub fn hexDigit(c: u8): i64
```

_Undocumented._

### `httpDo`

```milo
pub fn httpDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `httpsDo`

```milo
pub fn httpsDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError>
```

_Undocumented._

### `isHttps`

```milo
pub fn isHttps(url: &string): bool
```

_Undocumented._

### `parseBody`

```milo
pub fn parseBody(raw: &string): string
```

_Undocumented._

### `parseHost`

```milo
pub fn parseHost(url: &string): string
```

_Undocumented._

### `parsePath`

```milo
pub fn parsePath(url: &string): string
```

_Undocumented._

### `parsePort`

```milo
pub fn parsePort(url: &string): u16
```

_Undocumented._

### `parseRawHeaders`

```milo
pub fn parseRawHeaders(raw: &string): string
```

_Undocumented._

### `parseResponse`

```milo
pub fn parseResponse(raw: string): Response
```

_Undocumented._

### `parseStatus`

```milo
pub fn parseStatus(raw: &string): i32
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
pub fn schemeOffset(url: &string): i64
```

_Undocumented._

### `startsWith`

```milo
pub fn startsWith(s: &string, prefix: &string): bool
```

_Undocumented._

### `strEqNocase`

```milo
pub fn strEqNocase(a: &string, ai: i64, b: &string, blen: i64): bool
```

_Undocumented._

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
