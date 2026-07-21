# std/os

## std/os

### `acceptFd`

```milo
fn acceptFd(fd: i32): i32
```

Accept one connection; returns the client fd (<0 on error). In a green task
the client fd is left nonblocking so later readFd/writeFd calls skip a
redundant fcntl round-trip.

### `acceptFdNb`

```milo
fn acceptFdNb(fd: i32): i32
```

Single-shot nonblocking accept: the client fd, or -1 when no connection is
pending. For event loops that multiplex accept with other work and must not
park on the listener — a blocking accept stops every other event source
until the next connection arrives (milojs's cold-fetch hang).

### `bindIn`

```milo
fn bindIn(fd: i32, addr: &SockAddrIn): i32
```

_Undocumented._

### `bindIn6`

```milo
fn bindIn6(fd: i32, addr: &SockAddrIn6): i32
```

_Undocumented._

### `bindUn`

```milo
fn bindUn(fd: i32, addr: &SockAddrUn): i32
```

_Undocumented._

### `connectFd`

```milo
fn connectFd(fd: i32, addr: *SockAddr, addrlen: u32): i32
```

connect(2). In a green task: nonblocking connect, park until writable,
then check SO_ERROR. Returns 0 on success, <0 on failure.
Green-aware connect. Takes the raw seam so it serves every family; the per-family
entry points below (connectFdIn/connectFdIn6/connectFdUn) are what callers use.

### `connectFdIn`

```milo
fn connectFdIn(fd: i32, addr: &SockAddrIn): i32
```

_Undocumented._

### `connectFdIn6`

```milo
fn connectFdIn6(fd: i32, addr: &SockAddrIn6): i32
```

_Undocumented._

### `connectFdUn`

```milo
fn connectFdUn(fd: i32, addr: &SockAddrUn): i32
```

_Undocumented._

### `connectIn`

```milo
fn connectIn(fd: i32, addr: &SockAddrIn): i32
```

_Undocumented._

### `connectIn6`

```milo
fn connectIn6(fd: i32, addr: &SockAddrIn6): i32
```

_Undocumented._

### `connectUn`

```milo
fn connectUn(fd: i32, addr: &SockAddrUn): i32
```

_Undocumented._

### `getSockPort`

```milo
fn getSockPort(fd: i32): i32
```

The bound port, whatever family the socket is. getsockname writes into storage-sized
space because the kernel picks the family; sin_port and sin6_port BOTH sit at offset 2
(same invariant as sun_path), so one read serves v4 and v6. Returns -1 on failure.

### `readFd`

```milo
fn readFd(fd: i32, buf: *u8, len: i64): i64
```

One read(2). Returns bytes read, 0 at EOF, <0 on error.

### `sslConnectFd`

```milo
fn sslConnectFd(ssl: *u8, fd: i32): i32
```

Drive SSL_connect to completion. Returns 1 on success (SSL_connect result otherwise).

### `sslReadFd`

```milo
fn sslReadFd(ssl: *u8, fd: i32, buf: *u8, len: i32): i32
```

One SSL_read. Returns bytes read (>0), or <=0 on close/error.

### `sslWriteFd`

```milo
fn sslWriteFd(ssl: *u8, fd: i32, buf: *u8, len: i32): i32
```

One SSL_write (OpenSSL default writes all-or-WANT; no partial handling needed).

### `writeFd`

```milo
fn writeFd(fd: i32, buf: *u8, len: i64): i64
```

Write all len bytes (loops over partial writes). Returns len or <0 on error.
