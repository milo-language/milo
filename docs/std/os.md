# std/os

## std/os

### `acceptFd`

```milo
fn acceptFd(fd: i32): i32
```

Accept one connection; returns the client fd (<0 on error). In a green task
the client fd is left nonblocking so later readFd/writeFd calls skip a
redundant fcntl round-trip.

### `connectFd`

```milo
fn connectFd(fd: i32, addr: &SockAddrIn, addrlen: u32): i32
```

connect(2). In a green task: nonblocking connect, park until writable,
then check SO_ERROR. Returns 0 on success, <0 on failure.

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
