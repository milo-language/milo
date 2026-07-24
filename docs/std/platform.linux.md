# std/platform.linux

## std/platform.linux

### `addrinfoAddrOffset`

```milo
pub fn addrinfoAddrOffset(): i64
```

offset of aiAddr field in struct addrinfo (swapped with aiCanonname vs macOS)

### `afInet6`

```milo
pub fn afInet6(): i32
```

AF_INET6 is 10 here — one of the few socket constants that actually differs across the
two platforms (AF_INET and AF_UNIX are both the same on each).

### `closeSocket`

```milo
pub fn closeSocket(fd: i32): i32
```

A POSIX socket IS an fd, so closing it is just close(); Windows needs a distinct
closesocket(), which is why this name exists on all arms.

### `devNullPath`

```milo
pub fn devNullPath(): string
```

The bit-bucket device path. POSIX spells it /dev/null; Windows spells it NUL.

### `direntNameOffset`

```milo
pub fn direntNameOffset(): i64
```

_Undocumented._

### `direntTypeOffset`

```milo
pub fn direntTypeOffset(): i64
```

struct dirent layout

### `eagain`

```milo
pub fn eagain(): i32
```

_Undocumented._

### `einprogress`

```milo
pub fn einprogress(): i32
```

_Undocumented._

### `ensureNetInit`

```milo
pub fn ensureNetInit(): void
```

Winsock has no POSIX counterpart: sockets are ready to use with no init, and their
errors go through errno like everything else. These fold to that so std/net's socket
paths read the same on every platform (see platform.windows for the real work).

### `epollCtlAdd`

```milo
pub fn epollCtlAdd(): i32
```

_Undocumented._

### `epollCtlDel`

```milo
pub fn epollCtlDel(): i32
```

_Undocumented._

### `epollCtlMod`

```milo
pub fn epollCtlMod(): i32
```

_Undocumented._

### `epollErr`

```milo
pub fn epollErr(): u32
```

_Undocumented._

### `epollHup`

```milo
pub fn epollHup(): u32
```

_Undocumented._

### `epollIn`

```milo
pub fn epollIn(): u32
```

_Undocumented._

### `epollOneshot`

```milo
pub fn epollOneshot(): u32
```

_Undocumented._

### `epollOut`

```milo
pub fn epollOut(): u32
```

_Undocumented._

### `fGetfl`

```milo
pub fn fGetfl(): i32
```

_Undocumented._

### `fSetfl`

```milo
pub fn fSetfl(): i32
```

_Undocumented._

### `getErrno`

```milo
pub fn getErrno(): i32
```

_Undocumented._

### `makeSockaddr`

```milo
pub fn makeSockaddr(port: u16, addr: u32): SockAddrIn
```

_Undocumented._

### `makeSockaddr6`

```milo
pub fn makeSockaddr6(port: u16, addr: [u8; 16], scopeId: u32): SockAddrIn6
```

IPv6 address. `addr` is the 16 raw bytes in network order; `scopeId` is the interface
index for a link-local address (fe80::/10), 0 otherwise.

### `makeSockaddrUn`

```milo
pub fn makeSockaddrUn(path: &string): SockAddrUn
```

Whole-struct length; bind/connect want it for AF_UNIX.
AF_UNIX address for `path`. Truncates at sockAddrUnMaxPath so the kernel always sees a
NUL-terminated path; callers should reject longer paths rather than connect to a
silently shortened one (UnixListener/UnixStream do).

### `makeZeroedSockaddr`

```milo
pub fn makeZeroedSockaddr(): SockAddrIn
```

_Undocumented._

### `makeZeroedSockaddrStorage`

```milo
pub fn makeZeroedSockaddrStorage(): SockAddrStorage
```

128 bytes of zeroes; the kernel fills in whichever family the peer used.

### `mapAnon`

```milo
pub fn mapAnon(): i32
```

_Undocumented._

### `mapPrivate`

```milo
pub fn mapPrivate(): i32
```

_Undocumented._

### `mapPrivateAnon`

```milo
pub fn mapPrivateAnon(): i32
```

_Undocumented._

### `netEagain`

```milo
pub fn netEagain(): i32
```

_Undocumented._

### `netEinprogress`

```milo
pub fn netEinprogress(): i32
```

_Undocumented._

### `netErrno`

```milo
pub fn netErrno(): i32
```

_Undocumented._

### `oNonblock`

```milo
pub fn oNonblock(): i32
```

_Undocumented._

### `oWriteCreateAppend`

```milo
pub fn oWriteCreateAppend(): i32
```

_Undocumented._

### `oWriteCreateTrunc`

```milo
pub fn oWriteCreateTrunc(): i32
```

_Undocumented._

### `protNone`

```milo
pub fn protNone(): i32
```

_Undocumented._

### `protRead`

```milo
pub fn protRead(): i32
```

_Undocumented._

### `protWrite`

```milo
pub fn protWrite(): i32
```

_Undocumented._

### `sigchldNum`

```milo
pub fn sigchldNum(): i32
```

17 here, 20 on darwin (verified against asm-generic/signal.h and sys/signal.h
respectively). The only signal std/signal needs that isn't same-numbered on both.

### `sockAddrIn6Len`

```milo
pub fn sockAddrIn6Len(): u32
```

_Undocumented._

### `sockAddrInLen`

```milo
pub fn sockAddrInLen(): u32
```

_Undocumented._

### `sockAddrStorageLen`

```milo
pub fn sockAddrStorageLen(): u32
```

_Undocumented._

### `sockAddrUnLen`

```milo
pub fn sockAddrUnLen(): u32
```

_Undocumented._

### `sockAddrUnMaxPath`

```milo
pub fn sockAddrUnMaxPath(): i64
```

Longest path that still leaves room for the NUL the kernel expects.

### `sockRead`

```milo
pub fn sockRead(fd: i32, buf: *u8, nbyte: i64): i64
```

Socket data IO seam. On POSIX read()/write() work on socket fds, so these alias them; the
Windows arm routes to recv()/send() because a SOCKET there is not a CRT fd (calling the
CRT _read/_write on one fast-fails). Named so std/os's green helpers stay single-source.

### `sockWrite`

```milo
pub fn sockWrite(fd: i32, buf: *u8, nbyte: i64): i64
```

_Undocumented._

### `soError`

```milo
pub fn soError(): i32
```

_Undocumented._

### `solSocket`

```milo
pub fn solSocket(): i32
```

_Undocumented._

### `soReuseaddr`

```milo
pub fn soReuseaddr(): i32
```

_Undocumented._

### `statBufSize`

```milo
pub fn statBufSize(): i64
```

_Undocumented._

### `statModeOffset`

```milo
pub fn statModeOffset(): i64
```

struct stat layout (Linux x8664)

### `statSizeOffset`

```milo
pub fn statSizeOffset(): i64
```

_Undocumented._

### `uctxLinkOffset`

```milo
pub fn uctxLinkOffset(): i64
```

_Undocumented._

### `uctxSize`

```milo
pub fn uctxSize(): i64
```

sizeof(ucontext_t) on linux x86_64

### `uctxStackPtrOffset`

```milo
pub fn uctxStackPtrOffset(): i64
```

_Undocumented._

### `uctxStackSizeOffset`

```milo
pub fn uctxStackSizeOffset(): i64
```

_Undocumented._
