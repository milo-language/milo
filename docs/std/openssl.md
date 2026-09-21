# std/openssl

## std/openssl

### `sslAcceptFd`

```milo
pub fn sslAcceptFd(ssl: *u8, fd: i32): i32
```

Drive SSL_accept to completion — the server-side mirror of sslConnectFd.
Returns 1 on success (SSL_accept result otherwise).

### `sslConnectFd`

```milo
pub fn sslConnectFd(ssl: *u8, fd: i32): i32
```

Drive SSL_connect to completion. Returns 1 on success (SSL_connect result otherwise).

### `sslReadFd`

```milo
pub fn sslReadFd(ssl: *u8, fd: i32, buf: *u8, len: i32): i32
```

One SSL_read. Returns bytes read (>0), or <=0 on close/error.

### `sslWriteFd`

```milo
pub fn sslWriteFd(ssl: *u8, fd: i32, buf: *u8, len: i32): i32
```

One SSL_write (OpenSSL default writes all-or-WANT; no partial handling needed).
