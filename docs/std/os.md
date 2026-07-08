# std/os

## std/os

### `acceptFd`

```milo
fn acceptFd(fd: i32): i32
```

_Undocumented._

### `connectFd`

```milo
fn connectFd(fd: i32, addr: &SockAddrIn, addrlen: u32): i32
```

_Undocumented._

### `readFd`

```milo
fn readFd(fd: i32, buf: *u8, len: i64): i64
```

_Undocumented._

### `sslConnectFd`

```milo
fn sslConnectFd(ssl: *u8, fd: i32): i32
```

_Undocumented._

### `sslReadFd`

```milo
fn sslReadFd(ssl: *u8, fd: i32, buf: *u8, len: i32): i32
```

_Undocumented._

### `sslWriteFd`

```milo
fn sslWriteFd(ssl: *u8, fd: i32, buf: *u8, len: i32): i32
```

_Undocumented._

### `writeFd`

```milo
fn writeFd(fd: i32, buf: *u8, len: i64): i64
```

_Undocumented._
