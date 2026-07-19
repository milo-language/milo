# std/ws

## std/ws

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `extractWsKey`

```milo
fn extractWsKey(raw: &string): string
```

Extract Sec-WebSocket-Key from raw HTTP request.

### `isWsUpgrade`

```milo
fn isWsUpgrade(raw: &string): bool
```

Check if raw HTTP request bytes contain a WebSocket upgrade request.

### `WS_BINARY`

```milo
fn WS_BINARY(): u8
```

_Undocumented._

### `WS_CLOSE`

```milo
fn WS_CLOSE(): u8
```

_Undocumented._

### `WS_CONTINUATION`

```milo
fn WS_CONTINUATION(): u8
```

_Undocumented._

### `WS_PING`

```milo
fn WS_PING(): u8
```

_Undocumented._

### `WS_PONG`

```milo
fn WS_PONG(): u8
```

_Undocumented._

### `WS_TEXT`

```milo
fn WS_TEXT(): u8
```

_Undocumented._

### `wsAccept`

```milo
fn wsAccept(fd: i32, rawRequest: &string): Result<WsConn, string>
```

Accept a WebSocket upgrade on an already-accepted TCP fd.
Pass the raw HTTP request bytes so the handshake can be completed.

### `WsConn.close`

```milo
fn WsConn.close(self: &mut WsConn): void
```

Send close frame and mark connection closed.

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

### `wsConnect`

```milo
fn wsConnect(ip: u32, port: u16, path: &string): Result<WsConn, string>
```

Connect to a WebSocket server. Performs TCP connect + HTTP upgrade handshake.
Returns a WsConn on successful 101 response.

### `wsConnectTls`

```milo
fn wsConnectTls(ip: u32, port: u16, hostname: &string, path: &string): Result<WsConn, string>
```

Connect to a WebSocket server over TLS (wss://). Performs TCP connect, TLS
handshake (blocking — call before setting fds nonblocking), then the HTTP
upgrade handshake over the encrypted channel. `hostname` is used for SNI,
certificate validation, and the Host header.
