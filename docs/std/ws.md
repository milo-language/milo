# std/ws

## std/ws

### `computeAcceptKey`

```milo
pub fn computeAcceptKey(clientKey: &string): string
```

_Undocumented._

### `extractWsKey`

```milo
pub fn extractWsKey(raw: &string): string
```

Extract Sec-WebSocket-Key from raw HTTP request.

### `isWsUpgrade`

```milo
pub fn isWsUpgrade(raw: &string): bool
```

Check if raw HTTP request bytes contain a WebSocket upgrade request.

### `wsAccept`

```milo
pub fn wsAccept(fd: i32, rawRequest: &string): Result<WsConn, string>
```

Accept a WebSocket upgrade on an already-accepted TCP fd.
Pass the raw HTTP request bytes so the handshake can be completed.

### `WsConn.close`

```milo
fn WsConn.close(self: &mut WsConn): void
```

Send close frame and mark connection closed.

### `WsConn.fd`

```milo
fn WsConn.fd(self: &WsConn): i32
```

The socket fd. Callers select and poll on it, which is why it is reachable at all;
going through a method is what lets `_ctx`, `_closed` and `_isClient` stay
file-private.

### `WsConn.ping`

```milo
fn WsConn.ping(self: &WsConn): Result<i32, string>
```

Send a ping.

### `WsConn.recv`

```milo
fn WsConn.recv(self: &mut WsConn): Result<WsMessage, string>
```

Read next WebSocket message. Handles fragmentation, responds to ping automatically.

### `WsConn.sendBinary`

```milo
fn WsConn.sendBinary(self: &WsConn, data: &string): Result<i32, string>
```

Send a binary message.

### `WsConn.sendText`

```milo
fn WsConn.sendText(self: &WsConn, msg: &string): Result<i32, string>
```

Send a text message.

### `WsConn.tlsHandle`

```milo
fn WsConn.tlsHandle(self: &WsConn): i64
```

The TLS handle, 0 for plain TCP. Opaque to callers: pass it back to std, never
construct one.

### `WsConn.view`

```milo
fn WsConn.view(fd: i32, ssl: i64, isClient: bool): WsConn
```

A second handle over a socket some other WsConn owns: same fd and TLS handle, but
this one never closes them. It is how one task reads while another writes on the
same connection (`ws.fd()` / `ws.tlsHandle()` are the values to pass). The owner
must outlive it.

### `wsConnect`

```milo
pub fn wsConnect(ip: u32, port: u16, path: &string): Result<WsConn, string>
```

Connect to a WebSocket server. Performs TCP connect + HTTP upgrade handshake.
Returns a WsConn on successful 101 response.

### `wsConnectTls`

```milo
pub fn wsConnectTls(ip: u32, port: u16, hostname: &string, path: &string): Result<WsConn, string>
```

Connect to a WebSocket server over TLS (wss://). Performs TCP connect, TLS
handshake (blocking — call before setting fds nonblocking), then the HTTP
upgrade handshake over the encrypted channel. `hostname` is used for SNI,
certificate validation, and the Host header.
