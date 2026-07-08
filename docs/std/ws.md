# std/ws

## std/ws

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `Drop.extractWsKey`

```milo
fn Drop.extractWsKey(raw: &string): string
```

_Undocumented._

### `Drop.isWsUpgrade`

```milo
fn Drop.isWsUpgrade(raw: &string): bool
```

_Undocumented._

### `Drop.wsAccept`

```milo
fn Drop.wsAccept(fd: i32, rawRequest: &string): Result<WsConn, string>
```

_Undocumented._

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

### `WsConn.close`

```milo
fn WsConn.close(self: &mut WsConn): void
```

_Undocumented._

### `WsConn.ping`

```milo
fn WsConn.ping(self: &WsConn): Result<i32, string>
```

_Undocumented._

### `WsConn.recv`

```milo
fn WsConn.recv(self: &mut WsConn): Result<WsMessage, string>
```

_Undocumented._

### `WsConn.sendBinary`

```milo
fn WsConn.sendBinary(self: &WsConn, data: &string): Result<i32, string>
```

_Undocumented._

### `WsConn.sendText`

```milo
fn WsConn.sendText(self: &WsConn, msg: &string): Result<i32, string>
```

_Undocumented._

### `WsConn.wsConnect`

```milo
fn WsConn.wsConnect(ip: u32, port: u16, path: &string): Result<WsConn, string>
```

_Undocumented._

### `WsConn.wsConnectTls`

```milo
fn WsConn.wsConnectTls(ip: u32, port: u16, hostname: &string, path: &string): Result<WsConn, string>
```

_Undocumented._
